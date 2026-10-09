import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { installCatalogConnector } from '../src/main/agent/mcp-connectors'
import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import { sha256 } from '../src/main/agent/packages/installer-utils'
import { OFFICIAL_REGISTRY_ID } from '../src/main/agent/packages/official-registry'
import { registryKeyId, signRegistryIndex } from '../src/main/agent/packages/signature'

function fixture(): {
  root: string
  source: string
  assets: Map<string, Buffer>
  trustedKeys: { keyId: string; publicKey: string }[]
} {
  const root = mkdtempSync(join(tmpdir(), 'phi-connector-phases-'))
  const source = join(root, 'source')
  mkdirSync(source)
  const manifest = Buffer.from(
    'schemaVersion: 1\nid: demo-connector\ntype: mcp\nversion: 1.0.0\ntitle: Demo\nsummary: Fixture connector\nconnector:\n  transport: http\n  publisher: Phi\n  category: 科研数据\n  url: https://example.test/mcp\n  auth: none\n'
  )
  writeFileSync(join(source, 'phi-package.yaml'), manifest)
  const filesJson = Buffer.from(
    JSON.stringify({
      version: 1,
      files: [{ path: 'phi-package.yaml', sha256: sha256(manifest), size: manifest.length }]
    })
  )
  const archive = createDeterministicTarGz([
    { path: 'phi-package.yaml', data: manifest },
    { path: 'files.json', data: filesJson }
  ])
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-10-08T00:00:00Z',
      packages: [
        {
          id: 'demo-connector',
          type: 'mcp',
          version: '1.0.0',
          title: 'Demo',
          summary: 'Fixture connector',
          dependsOn: [],
          archive: 'demo.tar.gz',
          sha256: sha256(archive),
          size: archive.length,
          manifestAsset: { path: 'demo.yaml', sha256: sha256(manifest), size: manifest.length }
        }
      ]
    })
  )
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return {
    root,
    source,
    trustedKeys: [{ keyId: registryKeyId(publicPem), publicKey: publicPem }],
    assets: new Map([
      ['index.json', index],
      ['index.sig.json', Buffer.from(JSON.stringify(signRegistryIndex(index, privatePem)))],
      ['demo.yaml', manifest],
      ['demo.tar.gz', archive]
    ])
  }
}

test('official connector installation reports downloading before retrieval and installing only after verified archive retrieval', async () => {
  const f = fixture()
  const events: string[] = []
  const agentDir = join(f.root, 'agent')
  const fetcher: typeof fetch = async (input) => {
    const asset = new URL(String(input)).pathname.split('/').at(-1)!
    events.push(`fetch:${asset}`)
    const data = f.assets.get(asset)
    return data ? new Response(new Uint8Array(data)) : new Response(null, { status: 404 })
  }
  try {
    const installed = await installCatalogConnector(
      OFFICIAL_REGISTRY_ID,
      'demo-connector',
      '1.0.0',
      {
        agentDir,
        appVersion: '1.0.0',
        baseUrl: 'https://example.test/registry/',
        trustedKeys: f.trustedKeys,
        fetch: fetcher,
        onPhase: (phase) => {
          events.push(phase)
          assert.equal(existsSync(join(agentDir, 'mcp.json')), false)
        }
      }
    )
    assert.equal(installed[0]?.id, 'demo-connector')
    assert.equal(events[0], 'downloading')
    assert.equal(events.at(-1), 'installing')
    assert.ok(events.indexOf('fetch:demo.tar.gz') < events.indexOf('installing'))
    assert.deepEqual(
      events.filter((event) => !event.startsWith('fetch:')),
      ['downloading', 'installing']
    )
    assert.equal(existsSync(join(agentDir, 'mcp.json')), true)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('local source and local registry installs report installing without a download stage', async () => {
  const f = fixture()
  const registry = join(f.root, 'registry')
  mkdirSync(registry)
  writeFileSync(join(registry, 'index.json'), f.assets.get('index.json')!)
  writeFileSync(join(registry, 'demo.tar.gz'), f.assets.get('demo.tar.gz')!)
  try {
    for (const [index, source] of [f.source, registry].entries()) {
      const events: string[] = []
      const agentDir = join(f.root, `agent-${index}`)
      await installCatalogConnector(source, 'demo-connector', '1.0.0', {
        agentDir,
        appVersion: '1.0.0',
        onPhase: (phase) => {
          assert.equal(existsSync(join(agentDir, 'mcp.json')), false)
          events.push(phase)
        }
      })
      assert.deepEqual(events, ['installing'])
      assert.equal(existsSync(join(agentDir, 'mcp.json')), true)
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('failed official retrieval never reports installation or changes configuration', async () => {
  const f = fixture()
  const agentDir = join(f.root, 'agent')
  const events: string[] = []
  try {
    await assert.rejects(
      installCatalogConnector(OFFICIAL_REGISTRY_ID, 'demo-connector', '1.0.0', {
        agentDir,
        baseUrl: 'https://example.test/registry/',
        trustedKeys: f.trustedKeys,
        fetch: async () => {
          throw new Error('fixture offline')
        },
        onPhase: (phase) => events.push(phase)
      }),
      /fixture offline/
    )
    assert.deepEqual(events, ['downloading'])
    assert.equal(existsSync(join(agentDir, 'mcp.json')), false)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
