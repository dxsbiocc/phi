/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

function removeOwnedLock(lockPath, ownerName) {
  try {
    // Exact owner filenames protect replacement locks from stale cleanup.
    unlinkSync(path.join(lockPath, ownerName))
    // A replacement owner's nonempty directory cannot be removed.
    rmdirSync(lockPath)
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
  }
}

function recoverDeadLock(lockPath) {
  let entries
  try {
    entries = readdirSync(lockPath, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (entries.length !== 1 || !entries[0].isFile()) return
  const owner = /^owner-(\d+)-[0-9a-f-]{36}$/.exec(entries[0].name)
  if (!owner) return
  try {
    process.kill(Number(owner[1]), 0)
  } catch (error) {
    if (error.code === 'ESRCH') removeOwnedLock(lockPath, entries[0].name)
  }
}

export function withBuildLock(
  lockPath,
  action,
  { timeoutMs = 10_000, description = 'build publication' } = {}
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('build-lock: timeoutMs must be positive')
  }
  const ownerName = `owner-${process.pid}-${randomUUID()}`
  const candidate = `${lockPath}.${ownerName}`
  const deadline = Date.now() + timeoutMs
  const waitCell = new Int32Array(new SharedArrayBuffer(4))
  let acquired = false
  mkdirSync(candidate)
  try {
    writeFileSync(path.join(candidate, ownerName), '')
    while (!acquired) {
      try {
        // A prepopulated directory makes lock ownership visible atomically.
        renameSync(candidate, lockPath)
        acquired = true
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
        recoverDeadLock(lockPath)
        if (Date.now() >= deadline) {
          throw new Error(`build-lock: timed out waiting for ${description}`)
        }
        Atomics.wait(waitCell, 0, 0, Math.min(25, deadline - Date.now()))
      }
    }
    return action()
  } finally {
    if (acquired) removeOwnedLock(lockPath, ownerName)
    rmSync(candidate, { force: true, recursive: true })
  }
}
