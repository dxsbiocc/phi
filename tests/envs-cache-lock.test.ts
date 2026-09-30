import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { acquirePackageCacheLock } from '../src/main/agent/envs/lock'

test('the package cache lock serialises runtime roots that share one pkgs cache', async () => {
  const base = mkdtempSync(join(tmpdir(), 'phi-cache-lock-'))
  try {
    const shared = join(base, 'shared-pkgs')
    mkdirSync(shared)
    const rootA = join(base, 'a')
    const rootB = join(base, 'b')
    mkdirSync(rootA)
    mkdirSync(rootB)
    symlinkSync(shared, join(rootA, 'pkgs'), 'dir')
    symlinkSync(shared, join(rootB, 'pkgs'), 'dir')

    const first = await acquirePackageCacheLock({ root: rootA })
    let waited = false
    let acquiredSecond = false
    const second = acquirePackageCacheLock({
      root: rootB,
      onWait: () => {
        waited = true
      }
    }).then((lock) => {
      acquiredSecond = true
      return lock
    })

    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.equal(acquiredSecond, false, 'second root must wait while the first holds the cache')
    assert.equal(waited, true)

    first.release()
    const lock = await second
    assert.equal(acquiredSecond, true)
    lock.release()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('an aborted wait for the package cache rejects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-cache-lock-abort-'))
  try {
    const held = await acquirePackageCacheLock({ root })
    const controller = new AbortController()
    const pending = acquirePackageCacheLock({ root, signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    await assert.rejects(pending, /aborted/)
    held.release()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
