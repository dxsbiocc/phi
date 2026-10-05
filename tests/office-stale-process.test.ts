import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanupStaleOfficeProcesses } from '../src/main/agent/office/office-stale-process'

test('closes only exact OfficeCLI resident and watch commands for the registered draft', async () => {
  const alive = new Set([101, 102, 103])
  let closeCalls = 0
  const killed: number[] = []

  const result = await cleanupStaleOfficeProcesses('/runtime/officecli', '/draft/book.xlsx', {
    fileOwnerPids: async () => [101, 103],
    listProcesses: async () => [
      { pid: 101, command: '/runtime/officecli __resident-serve__ /draft/book.xlsx' },
      { pid: 102, command: '/runtime/officecli watch /draft/book.xlsx --port 31111' },
      { pid: 103, command: '/runtime/officecli __resident-serve__ /draft/other.xlsx' }
    ],
    close: async () => {
      closeCalls += 1
      alive.delete(101)
      alive.delete(102)
    },
    isAlive: (pid) => alive.has(pid),
    kill: (pid) => {
      killed.push(pid)
      alive.delete(pid)
    },
    sleep: async () => undefined,
    exitTimeoutMs: 1,
    termGraceMs: 1
  })

  assert.deepEqual(result.cleanedPids, [101, 102])
  assert.equal(closeCalls, 1)
  assert.deepEqual(killed, [])
  assert.equal(alive.has(103), true)
})

test('does not touch non-matching processes even when lsof reports them', async () => {
  let closeCalls = 0
  let killCalls = 0
  const result = await cleanupStaleOfficeProcesses('/runtime/officecli', '/draft/book.xlsx', {
    fileOwnerPids: async () => [201],
    listProcesses: async () => [
      { pid: 201, command: '/runtime/officecli __resident-serve__ /draft/other.xlsx' },
      { pid: 202, command: '/other/officecli __resident-serve__ /draft/book.xlsx' }
    ],
    close: async () => {
      closeCalls += 1
    },
    kill: () => {
      killCalls += 1
    }
  })

  assert.deepEqual(result.cleanedPids, [])
  assert.equal(closeCalls, 0)
  assert.equal(killCalls, 0)
})

test('fails without killing when ps cannot validate an lsof candidate', async () => {
  let killCalls = 0
  await assert.rejects(
    cleanupStaleOfficeProcesses('/runtime/officecli', '/draft/book.xlsx', {
      fileOwnerPids: async () => [301],
      listProcesses: async () => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      },
      kill: () => {
        killCalls += 1
      }
    }),
    (error: unknown) => (error as { code?: unknown }).code === 'stale_process_unverified'
  )
  assert.equal(killCalls, 0)
})

test('reports stale_resident_stuck after close and SIGTERM both fail', async () => {
  let closeCalls = 0
  const signals: Array<[number, NodeJS.Signals]> = []
  await assert.rejects(
    cleanupStaleOfficeProcesses('/runtime/officecli', '/draft/book.xlsx', {
      fileOwnerPids: async () => [401],
      listProcesses: async () => [
        { pid: 401, command: '/runtime/officecli __resident-serve__ /draft/book.xlsx' }
      ],
      close: async () => {
        closeCalls += 1
      },
      isAlive: () => true,
      kill: (pid, signal) => signals.push([pid, signal]),
      sleep: async () => new Promise((resolve) => setTimeout(resolve, 2)),
      exitTimeoutMs: 1,
      termGraceMs: 1
    }),
    (error: unknown) => (error as { code?: unknown }).code === 'stale_resident_stuck'
  )
  assert.equal(closeCalls, 1)
  assert.deepEqual(signals, [[401, 'SIGTERM']])
})
