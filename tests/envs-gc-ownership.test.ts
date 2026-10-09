import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectGarbage } from '../src/main/agent/envs/gc'
import { updateEnvironmentEntry } from '../src/main/agent/envs/index-store'
import { currentPlatform } from '../src/main/agent/envs/platform'

const ID = 'phi-owned-0123456789ab'
function record(root: string, prefix: string): void {
  updateEnvironmentEntry(root, ID, {
    name: 'owned',
    kind: 'package',
    platform: currentPlatform(),
    prefix,
    status: 'ready',
    lockSha256: 'a'.repeat(64),
    referrers: []
  })
}

test('garbage collection refuses an indexed prefix outside Phi runtime', () => {
  const base = mkdtempSync(join(tmpdir(), 'phi-gc-boundary-'))
  try {
    const root = join(base, 'runtime')
    const unrelated = join(base, 'user-data')
    mkdirSync(unrelated)
    writeFileSync(join(unrelated, 'keep'), 'important')
    record(root, unrelated)
    assert.throws(() => collectGarbage(root), /受管目录之外/)
    assert.throws(() => collectGarbage(root, { dryRun: true }), /受管目录之外/)
    assert.ok(existsSync(join(unrelated, 'keep')))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('garbage collection refuses a symlinked runtime envs directory', () => {
  const base = mkdtempSync(join(tmpdir(), 'phi-gc-symlink-'))
  try {
    const root = join(base, 'runtime')
    const unrelated = join(base, 'user-data')
    mkdirSync(root)
    mkdirSync(join(unrelated, ID), { recursive: true })
    writeFileSync(join(unrelated, ID, 'keep'), 'important')
    symlinkSync(unrelated, join(root, 'envs'))
    record(root, join(root, 'envs', ID))
    assert.throws(() => collectGarbage(root), /符号链接/)
    assert.ok(existsSync(join(unrelated, ID, 'keep')))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('garbage collection still removes a genuinely owned unreferenced prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-gc-owned-'))
  try {
    const prefix = join(root, 'envs', ID)
    mkdirSync(prefix, { recursive: true })
    writeFileSync(join(prefix, 'remove'), 'owned')
    record(root, prefix)
    assert.deepEqual(collectGarbage(root).removed, [ID])
    assert.equal(existsSync(prefix), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('orphan recovery refuses a symlinked envs directory without an index', () => {
  const base = mkdtempSync(join(tmpdir(), 'phi-gc-orphan-boundary-'))
  try {
    const root = join(base, 'runtime')
    const unrelated = join(base, 'user-data')
    mkdirSync(root)
    mkdirSync(join(unrelated, ID), { recursive: true })
    writeFileSync(join(unrelated, ID, 'keep'), 'important')
    symlinkSync(unrelated, join(root, 'envs'))
    assert.throws(() => collectGarbage(root, { dryRun: true }), /符号链接/)
    assert.throws(() => collectGarbage(root), /符号链接/)
    assert.ok(existsSync(join(unrelated, ID, 'keep')))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('cache ownership is checked before deleting an owned environment', () => {
  const base = mkdtempSync(join(tmpdir(), 'phi-gc-cache-boundary-'))
  try {
    const root = join(base, 'runtime')
    const prefix = join(root, 'envs', ID)
    const unrelated = join(base, 'user-cache')
    mkdirSync(prefix, { recursive: true })
    mkdirSync(join(unrelated, ID), { recursive: true })
    writeFileSync(join(unrelated, ID, 'keep'), 'important')
    symlinkSync(unrelated, join(root, 'cache'))
    record(root, prefix)
    assert.throws(() => collectGarbage(root, { dryRun: true }), /符号链接/)
    assert.throws(() => collectGarbage(root), /符号链接/)
    assert.ok(existsSync(prefix), 'invalid cache must leave the environment intact')
    assert.ok(existsSync(join(unrelated, ID, 'keep')))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
