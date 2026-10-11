import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import { syncOfficialRegistry } from '../src/main/agent/packages/official-registry'
import { registryKeyId, signRegistryIndex } from '../src/main/agent/packages/signature'
import { readWrapperPackageDetail } from '../src/main/agent/packages/wrapper-detail'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))
const keyPair = generateKeyPairSync('ed25519')
const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const trustedKeys = [{ keyId: registryKeyId(publicKey), publicKey }]
const baseUrl = 'https://example.test/catalog/'
const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

const wrapperYaml = (name: string): string =>
  [
    `id: nf-core/modules/demo-${name}`,
    `name: Demo ${name}`,
    `summary: Demo ${name} wrapper`,
    'params:',
    '  reads:',
    '    kind: input',
    '    type: file',
    '    required: true',
    'outputs:',
    '  bam:',
    '    type: file',
    '    path: out/*.bam',
    '    primary: true'
  ].join('\n')

const archiveFiles = [
  {
    path: 'modules/nf-core/demo/view/wrapper/wrapper.yaml',
    data: Buffer.from(wrapperYaml('view'))
  },
  {
    path: 'modules/nf-core/demo/sort/wrapper/wrapper.yaml',
    data: Buffer.from(wrapperYaml('sort'))
  },
  { path: 'modules/nf-core/demo/broken/wrapper/wrapper.yaml', data: Buffer.from('not: [valid') },
  { path: 'modules/nf-core/demo/sort/main.nf', data: Buffer.from('process SORT {}\n') },
  { path: 'modules/nf-core/demo/sort/meta.yml', data: Buffer.from('description: Sort things\n') },
  {
    path: 'modules/nf-core/demo/sort/environment.yml',
    data: Buffer.from('channels: [conda-forge]\n')
  },
  { path: 'modules/nf-core/demo/sort/wrapper/dag.mmd', data: Buffer.from('flowchart TD\n') }
]

function fixture(options: { corrupt?: boolean } = {}): {
  agentDir: string
  requests: string[]
  options: Parameters<typeof syncOfficialRegistry>[0]
} {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-wrapper-detail-'))
  roots.push(agentDir)
  const archive = createDeterministicTarGz(archiveFiles)
  const entry = {
    id: 'module-nf-core-demo',
    type: 'wrapper',
    version: '1.0.0',
    title: 'demo family',
    summary: 'demo',
    archive: 'wrapper-module-nf-core-demo-1.0.0.tar.gz',
    sha256: digest(archive),
    size: archive.length,
    dependsOn: []
  }
  const index = Buffer.from(
    JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-08T00:00:00Z', packages: [entry] })
  )
  const flipped = Buffer.from(archive)
  flipped[flipped.length >> 1] ^= 0xff
  const served = options.corrupt ? flipped : archive
  const assets = new Map<string, Buffer>([
    ['index.json', index],
    ['index.sig.json', Buffer.from(JSON.stringify(signRegistryIndex(index, privateKey)))],
    [entry.archive, served]
  ])
  const requests: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname.split('/').at(-1)!
    requests.push(path)
    const data = assets.get(path)
    return data
      ? new Response(new Uint8Array(data), { status: 200 })
      : new Response(null, { status: 404 })
  }
  return { agentDir, requests, options: { agentDir, baseUrl, trustedKeys, fetch: fetcher } }
}

test('uninstalled package detail downloads only its own archive, lists valid wrappers, and caches it', async () => {
  const f = fixture()
  const registry = await syncOfficialRegistry(f.options)
  f.requests.length = 0
  const detail = await readWrapperPackageDetail(registry, 'module-nf-core-demo', f.options)
  assert.deepEqual(f.requests, ['wrapper-module-nf-core-demo-1.0.0.tar.gz'])
  assert.equal(detail.source, 'registry')
  assert.equal(detail.version, '1.0.0')
  assert.deepEqual(
    detail.wrappers.map((wrapper) => wrapper.id),
    ['nf-core/modules/demo-sort', 'nf-core/modules/demo-view']
  )
  const sort = detail.wrappers[0]
  assert.equal(sort.dag, 'flowchart TD\n')
  assert.equal(sort.details?.meta?.description, 'Sort things')
  assert.equal(sort.details?.environment, 'channels: [conda-forge]\n')
  assert.equal(detail.wrappers[1].dag, undefined)
  assert.equal(detail.wrappers[1].details, undefined)
  assert.equal(detail.wrappers[0].params.reads.required, true)
  assert.equal(detail.wrappers[0].outputs.bam.primary, true)
  assert.equal(detail.skipped, 1)
  f.requests.length = 0
  await readWrapperPackageDetail(registry, 'module-nf-core-demo', f.options)
  assert.deepEqual(f.requests, [])
})

test('installed package detail reads the local tree without any download', async () => {
  const f = fixture()
  const registry = await syncOfficialRegistry(f.options)
  const treeDir = join(f.agentDir, 'wrappers', 'tree')
  const paths = archiveFiles.map((file) => file.path).sort()
  for (const file of archiveFiles) {
    mkdirSync(dirname(join(treeDir, file.path)), { recursive: true })
    writeFileSync(join(treeDir, file.path), file.data)
  }
  writeFileSync(
    join(f.agentDir, 'wrappers', 'tree.json'),
    JSON.stringify({
      version: 1,
      packages: {
        'module-nf-core-demo': {
          version: '1.0.0',
          title: 'demo family',
          summary: 'demo',
          manifest: {
            schemaVersion: 1,
            id: 'module-nf-core-demo',
            type: 'wrapper',
            version: '1.0.0',
            title: 'demo family',
            summary: 'demo',
            dependsOn: [],
            files: 'files.json'
          },
          source: {
            registry: 'phi-packages',
            id: 'module-nf-core-demo',
            type: 'wrapper',
            version: '1.0.0',
            sha256: 'a'.repeat(64),
            installedAt: '2026-10-08T00:00:00.000Z',
            installedBy: 'user',
            trust: 'official'
          },
          paths
        }
      }
    })
  )
  f.requests.length = 0
  const detail = await readWrapperPackageDetail(registry, 'module-nf-core-demo', f.options)
  assert.deepEqual(f.requests, [])
  assert.equal(detail.source, 'installed')
  assert.equal(detail.wrappers.length, 2)
  assert.equal(detail.wrappers[0].details?.meta?.description, 'Sort things')
  assert.equal(detail.wrappers[0].dag, 'flowchart TD\n')
})

test('package detail rejects unknown packages and archives that fail verification', async () => {
  const f = fixture()
  const registry = await syncOfficialRegistry(f.options)
  await assert.rejects(readWrapperPackageDetail(registry, 'module-nf-core-missing', f.options))
  const bad = fixture({ corrupt: true })
  const badRegistry = await syncOfficialRegistry(bad.options)
  await assert.rejects(
    readWrapperPackageDetail(badRegistry, 'module-nf-core-demo', bad.options),
    /checksum mismatch/
  )
})
