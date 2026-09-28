import assert from 'node:assert/strict'
import test from 'node:test'

import { useSessionStore } from '../src/renderer/src/stores/sessionStore'
import { sessionDraftKey } from '../src/renderer/src/lib/sessionDrafts'
import type { CurrentSession } from '../src/renderer/src/types'

const location = {
  kind: 'ssh' as const,
  hostProfileId: 'host-a',
  remoteRoot: '/cluster/work',
  canonicalRoot: '/data/work'
}

function current(overrides: Partial<CurrentSession> = {}): CurrentSession {
  return {
    path: 'phi-session:remote-session-1',
    phiSessionId: 'remote-session-1',
    cwd: '/home/user/.phi/remote-project-anchors/project-a',
    displayCwd: '/cluster/work',
    projectId: 'project-a',
    projectLocation: location,
    sessionGeneration: 1,
    permissionMode: 'ask',
    status: 'idle',
    unreadKind: null,
    ...overrides
  }
}

test('renderer keeps private runtime cwd separate from the visible SSH project path', () => {
  const store = useSessionStore.getState()
  store.applyCurrentSession(current())
  const remote = useSessionStore.getState()
  assert.equal(remote.activeCwd, '/home/user/.phi/remote-project-anchors/project-a')
  assert.equal(remote.activeDisplayCwd, '/cluster/work')
  assert.equal(remote.activeProjectId, 'project-a')
  assert.deepEqual(remote.activeProjectLocation, location)

  const draftKey = sessionDraftKey({
    phiSessionId: remote.activePhiSessionId,
    path: remote.activeSessionPath,
    cwd: remote.activeCwd,
    sessionGeneration: remote.activeSessionGeneration
  })
  remote.setDraftInputs({ [draftKey]: 'unsent text while SSH is offline' })
  remote.applyCurrentSession(
    current({
      path: 'phi-session:ordinary-1',
      phiSessionId: 'ordinary-1',
      cwd: '/workspace',
      displayCwd: '/workspace',
      projectId: undefined,
      projectLocation: undefined,
      permissionMode: 'auto'
    })
  )
  assert.equal(useSessionStore.getState().activeProjectId, null)
  remote.applyCurrentSession(current({ sessionGeneration: 2 }))
  const restored = useSessionStore.getState()
  assert.equal(restored.activeDisplayCwd, '/cluster/work')
  assert.equal(restored.draftInputs[draftKey], 'unsent text while SSH is offline')
})
