import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { materializeRegistry } from '../src/main/agent/packages/materialize-registry'
import { cleanupStalePackageStaging, stagePackage } from '../src/main/agent/packages/staging'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))
const now = new Date('2026-10-17T04:00:00.000Z')
const stale = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)

function fixture(): {
  root: string
  agentDir: string
  registry: ReturnType<typeof materializeRegistry>
} {
  const root = mkdtempSync(join(tmpdir(), 'phi-staging-safety-'))
  roots.push(root)
  const agentDir = join(root, 'agent')
  const source = join(root, 'safe-skill')
  mkdirSync(source)
  writeFileSync(
    join(source, 'SKILL.md'),
    '---\nname: safe-skill\ndescription: Safe fixture\n---\n# Fixture\n'
  )
  writeFileSync(
    join(source, 'phi-package.yaml'),
    'schemaVersion: 1\nid: safe-skill\ntype: skill\nversion: 1.0.0\ntitle: Safe fixture\nsummary: Safe fixture\n'
  )
  const registry = materializeRegistry([source], join(root, 'registry'), {
    id: 'test-source',
    allowedTypes: ['skill']
  })
  return { root, agentDir, registry }
}

for (const target of ['staging', 'agent'] as const) {
  test(`stale cleanup rejects a symlinked ${target} root without deleting external files`, () => {
    const f = fixture()
    const outside = join(f.root, 'outside')
    const externalStaging = target === 'staging' ? outside : join(outside, '.staging')
    const externalOld = join(externalStaging, 'stale')
    mkdirSync(externalOld, { recursive: true })
    writeFileSync(join(externalOld, 'sentinel'), 'preserve external data')
    utimesSync(externalOld, stale, stale)
    if (target === 'staging') {
      mkdirSync(f.agentDir)
      symlinkSync(outside, join(f.agentDir, '.staging'))
    } else {
      symlinkSync(outside, f.agentDir)
    }
    assert.throws(
      () => cleanupStalePackageStaging({ agentDir: f.agentDir, now: () => now }),
      /symbolic link|symlink/
    )
    assert.equal(readFileSync(join(externalOld, 'sentinel'), 'utf8'), 'preserve external data')
  })

  test(`package staging rejects a symlinked ${target} root before writing external content`, () => {
    const f = fixture()
    const outside = join(f.root, 'outside')
    mkdirSync(outside)
    if (target === 'staging') {
      mkdirSync(f.agentDir)
      symlinkSync(outside, join(f.agentDir, '.staging'))
    } else {
      symlinkSync(outside, f.agentDir)
    }
    assert.throws(
      () =>
        stagePackage(f.registry, { ...f.registry.packages[0], installedBy: 'user' }, f.agentDir),
      /symbolic link|symlink/
    )
    assert.deepEqual(readdirSync(outside), [])
  })
}

test('normal staging preserves fresh content, removes stale content, and creates a missing safe root', () => {
  const f = fixture()
  assert.deepEqual(cleanupStalePackageStaging({ agentDir: f.agentDir }), [])
  assert.equal(existsSync(f.agentDir), false)
  const staged = stagePackage(
    f.registry,
    { ...f.registry.packages[0], installedBy: 'user' },
    f.agentDir
  )
  assert.equal(readFileSync(join(staged.dir, 'SKILL.md'), 'utf8').includes('# Fixture'), true)
  const old = join(f.agentDir, '.staging', 'stale')
  mkdirSync(old)
  writeFileSync(join(old, 'sentinel'), 'remove stale content')
  utimesSync(old, stale, stale)
  assert.deepEqual(cleanupStalePackageStaging({ agentDir: f.agentDir, now: () => now }), [old])
  assert.equal(existsSync(staged.dir), true)
  assert.equal(existsSync(old), false)
})
