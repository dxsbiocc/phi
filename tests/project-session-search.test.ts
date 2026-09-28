import assert from 'node:assert/strict'
import test from 'node:test'

import { loadProjectSessionsForSearch } from '../src/renderer/src/features/session-search/lib/projectSessionSearch'
import type { SessionSummary } from '../src/renderer/src/types'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const projects = Array.from({ length: 6 }, (_, index) => ({
  id: `project-${index}`,
  workingDirectory: `/projects/${index}`
}))

test('project search reveals completed groups before slow reads and limits concurrency', async () => {
  const reads = projects.map(() => deferred<SessionSummary[]>())
  const started: string[] = []
  const settled: string[] = []
  let active = 0
  let maxActive = 0
  const loading = loadProjectSessionsForSearch(
    projects,
    async (_, projectId) => {
      const index = projects.findIndex((project) => project.id === projectId)
      started.push(projectId)
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        return await reads[index].promise
      } finally {
        active -= 1
      }
    },
    (projectId) => settled.push(projectId),
    () => true
  )

  assert.deepEqual(
    started,
    projects.slice(0, 4).map((project) => project.id)
  )
  reads[1].resolve([])
  await new Promise(setImmediate)
  assert.deepEqual(settled, ['project-1'])
  assert.deepEqual(
    started,
    projects.slice(0, 5).map((project) => project.id)
  )

  for (const index of [0, 2, 3, 4, 5]) reads[index].resolve([])
  await loading
  assert.equal(settled.length, projects.length)
  assert.equal(maxActive, 4)
})

test('project search marks failed reads and stops starting new reads after cancellation', async () => {
  const reads = projects.map(() => deferred<SessionSummary[]>())
  const started: string[] = []
  const settled: string[] = []
  let current = true
  const loading = loadProjectSessionsForSearch(
    projects,
    (_, projectId) => {
      started.push(projectId)
      return reads[projects.findIndex((project) => project.id === projectId)].promise
    },
    (projectId, result) => settled.push(`${projectId}:${'failed' in result ? 'failed' : 'ok'}`),
    () => current
  )

  reads[0].reject(new Error('unavailable'))
  await new Promise(setImmediate)
  assert.deepEqual(settled, ['project-0:failed'])
  assert.equal(started.length, 5)

  current = false
  for (const index of [1, 2, 3, 4]) reads[index].resolve([])
  await loading
  assert.equal(started.length, 5)
  assert.deepEqual(settled, ['project-0:failed'])
})
