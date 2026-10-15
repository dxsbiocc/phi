import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  importedMemoryRolloutPath,
  parseProjectMemoryManifest
} from '../src/main/agent/engine/rpc/desktop-project-memory-cache'
const id = '01900000-0000-7000-8000-000000000001'
const entry = {
  id,
  fingerprint: 'a'.repeat(64),
  model: { provider: 'fixture', id: 'model' },
  published: true
}
const manifest = (value: unknown): unknown => ({
  schema: 1,
  epoch: 1,
  clearCutoff: 1,
  imports: { ['b'.repeat(64)]: value }
})

test('persisted memory checkpoints cannot grant deletion authority over an arbitrary file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-memory-victim-'))
  const victim = join(root, 'victim.txt')
  try {
    await writeFile(victim, 'keep this local file')
    await writeFile(
      join(root, 'imports.json'),
      JSON.stringify(manifest({ ...entry, path: victim }))
    )
    const cached = JSON.parse(await readFile(join(root, 'imports.json'), 'utf8'))
    assert.throws(() => parseProjectMemoryManifest(cached), /Invalid imported memory checkpoint/)
    assert.equal(await readFile(victim, 'utf8'), 'keep this local file')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('cleared valid checkpoints remain tombstones without requiring a rollout file', () => {
  const parsed = parseProjectMemoryManifest(manifest(entry))
  assert.equal(parsed.imports['b'.repeat(64)].published, true)
  assert.equal(
    importedMemoryRolloutPath('/private/project/rollouts', id),
    '/private/project/rollouts/' + id + '.jsonl'
  )
  assert.throws(
    () => importedMemoryRolloutPath('/private/project/rollouts', '../../victim'),
    /Invalid imported SDK memory identity/
  )
})
test('malformed checkpoint keys identities fingerprints model fields and generations fail closed', () => {
  for (const invalid of [
    { ...entry, id: '../victim' },
    { ...entry, fingerprint: 'bad' },
    { ...entry, model: { provider: 'fixture' } },
    { ...entry, published: 'yes' },
    { ...entry, model: { provider: 'fixture', id: 'model', apiKey: 'private' } }
  ])
    assert.throws(() => parseProjectMemoryManifest(manifest(invalid)))
  assert.throws(() =>
    parseProjectMemoryManifest({
      schema: 1,
      epoch: 0,
      clearCutoff: 0,
      imports: { __proto__: entry, bad: entry }
    })
  )
  assert.throws(() =>
    parseProjectMemoryManifest({ schema: 1, epoch: -1, clearCutoff: 0, imports: {} })
  )
})
