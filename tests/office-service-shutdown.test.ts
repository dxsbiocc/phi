import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OfficeServiceShutdown } from '../src/main/agent/office/office-service-shutdown'

interface FakeEntry {
  document: { artifactId: string; sessionId: string; residentPid: number; watchPid: number }
  operations: { cancel(): void; drain(): Promise<void> }
}

function entry(artifactId: string, residentPid: number, watchPid: number): FakeEntry {
  return {
    document: { artifactId, sessionId: 's1', residentPid, watchPid },
    operations: { cancel: () => undefined, drain: async () => undefined }
  }
}

function shutdownWith(
  entries: readonly FakeEntry[],
  releaseEntries: () => Promise<void>,
  kills: Array<[number, string]>
): OfficeServiceShutdown {
  const owned = new Map(entries.map((value) => [value.document.artifactId, value]))
  return new OfficeServiceShutdown({
    creation: { cancelMatching: async () => undefined },
    opening: { waitForPending: async () => undefined },
    cleanup: {
      releaseEntries,
      retryPending: async () => undefined,
      finish: async (work: Array<Promise<unknown>>) => {
        await Promise.all(work)
      }
    },
    owned,
    closingArtifacts: new Set<string>(),
    targets: { markArtifactReleased: () => undefined, clearSession: () => undefined },
    selection: { dispose: () => undefined },
    forgetRegisteredBlankSession: () => undefined,
    kill: (pid: number, signal: NodeJS.Signals) => {
      kills.push([pid, signal])
    }
  } as never)
}

test('quit shutdown stops waiting at its deadline and terminates only the pids it owns', async () => {
  const kills: Array<[number, string]> = []
  const hung = new Promise<void>(() => undefined)
  const shutdown = shutdownWith([entry('a', 111, 112), entry('b', 221, 222)], () => hung, kills)

  const started = Date.now()
  await shutdown.dispose({ deadlineMs: 50 })

  assert.ok(Date.now() - started < 1_000, 'dispose must return near its deadline')
  assert.deepEqual(
    kills.sort((x, y) => x[0] - y[0]),
    [
      [111, 'SIGTERM'],
      [112, 'SIGTERM'],
      [221, 'SIGTERM'],
      [222, 'SIGTERM']
    ]
  )
})

test('quit shutdown that finishes in time terminates nothing, and without a deadline it waits', async () => {
  const kills: Array<[number, string]> = []
  await shutdownWith([entry('a', 111, 112)], async () => undefined, kills).dispose({
    deadlineMs: 1_000
  })
  assert.deepEqual(kills, [])

  let released = false
  await shutdownWith(
    [entry('a', 111, 112)],
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      released = true
    },
    kills
  ).dispose()
  assert.equal(released, true)
  assert.deepEqual(kills, [])
})
