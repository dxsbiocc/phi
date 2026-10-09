import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loadProjectSessionsCached,
  resetProjectSessionLoadCacheForTesting,
  shouldPrefetchProjectSessions
} from '../src/renderer/src/components/session-sidebar/projectSessionLoading'
import type { SessionSummary } from '../src/renderer/src/types'

test('collapsed project rows prefetch sessions before the first expansion', () => {
  assert.equal(shouldPrefetchProjectSessions(false, false), true)
  assert.equal(shouldPrefetchProjectSessions(true, false), true)
  assert.equal(shouldPrefetchProjectSessions(false, true), false)
})

test('project session prefetch deduplicates concurrent and completed loads', async () => {
  resetProjectSessionLoadCacheForTesting()
  let calls = 0
  let release: ((sessions: SessionSummary[]) => void) | undefined
  const load = (): Promise<SessionSummary[]> => {
    calls += 1
    return new Promise((resolve) => {
      release = resolve
    })
  }

  const first = loadProjectSessionsCached('project-1', 0, load)
  const second = loadProjectSessionsCached('project-1', 0, load)
  assert.equal(calls, 1)
  release?.([])
  assert.deepEqual(await first, [])
  assert.deepEqual(await second, [])

  assert.deepEqual(await loadProjectSessionsCached('project-1', 0, load), [])
  assert.equal(calls, 1)
})
