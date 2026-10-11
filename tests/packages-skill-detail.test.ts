import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import { syncOfficialRegistry } from '../src/main/agent/packages/official-registry'
import { registryKeyId, signRegistryIndex } from '../src/main/agent/packages/signature'
import { readSkillPackageDetail } from '../src/main/agent/packages/skill-detail'
import { skillVersionDir, writeSkillsRegistry } from '../src/main/agent/packages/store'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))
const keyPair = generateKeyPairSync('ed25519')
const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const trustedKeys = [{ keyId: registryKeyId(publicKey), publicKey }]
const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const SKILL_MD = '---\nname: demo-skill\ndescription: A demo\n---\n# Demo\n\nUse it.\n'

function fixture(): {
  agentDir: string
  requests: string[]
  options: Parameters<typeof syncOfficialRegistry>[0]
} {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-skill-detail-'))
  roots.push(agentDir)
  const archive = createDeterministicTarGz([
    { path: 'SKILL.md', data: Buffer.from(SKILL_MD) },
    { path: 'references/guide.md', data: Buffer.from('guide') }
  ])
  const entry = {
    id: 'demo-skill',
    type: 'skill',
    version: '1.0.0',
    title: 'demo-skill',
    summary: 'A demo',
    archive: 'skill-demo-skill-1.0.0.tar.gz',
    sha256: digest(archive),
    size: archive.length,
    dependsOn: []
  }
  const index = Buffer.from(
    JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-08T00:00:00Z', packages: [entry] })
  )
  const assets = new Map<string, Buffer>([
    ['index.json', index],
    ['index.sig.json', Buffer.from(JSON.stringify(signRegistryIndex(index, privateKey)))],
    [entry.archive, archive]
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
  return {
    agentDir,
    requests,
    options: { agentDir, baseUrl: 'https://example.test/catalog/', trustedKeys, fetch: fetcher }
  }
}

test('an uninstalled skill package shows its SKILL.md from the verified archive, once', async () => {
  const f = fixture()
  const registry = await syncOfficialRegistry(f.options)
  f.requests.length = 0
  const detail = await readSkillPackageDetail(registry, 'demo-skill', f.options)
  assert.deepEqual(f.requests, ['skill-demo-skill-1.0.0.tar.gz'])
  assert.deepEqual(
    { id: detail.id, version: detail.version, source: detail.source },
    { id: 'demo-skill', version: '1.0.0', source: 'registry' }
  )
  assert.equal(detail.skillMd, SKILL_MD)
  f.requests.length = 0
  await readSkillPackageDetail(registry, 'demo-skill', f.options)
  assert.deepEqual(f.requests, [])
})

test('an installed skill package is read from disk without any download', async () => {
  const f = fixture()
  const registry = await syncOfficialRegistry(f.options)
  const dir = skillVersionDir('demo-skill', '1.0.0', f.agentDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), SKILL_MD)
  writeSkillsRegistry(
    {
      version: 1,
      skills: { 'demo-skill': { version: '1.0.0', installedAt: '2026-10-08T00:00:00Z' } }
    },
    f.agentDir
  )
  f.requests.length = 0
  const detail = await readSkillPackageDetail(registry, 'demo-skill', f.options)
  assert.deepEqual(f.requests, [])
  assert.equal(detail.source, 'installed')
  assert.equal(detail.skillMd, SKILL_MD)
})

test('unknown skill packages are rejected', async () => {
  const f = fixture()
  const registry = await syncOfficialRegistry(f.options)
  await assert.rejects(readSkillPackageDetail(registry, 'missing-skill', f.options), /找不到/)
})
