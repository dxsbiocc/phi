import assert from 'node:assert/strict'
import test from 'node:test'

import { RemoteMetadataBusyError } from '../src/main/agent/engine/rpc/runtime-metadata-control'
import {
  getCurrentContextUsage,
  type CurrentContextUsageOptions,
  type CurrentSessionPayload
} from '../src/main/agent/session/current-session-reads'

const remoteSession: CurrentSessionPayload = {
  path: 'phi-session:remote',
  phiSessionId: 'remote',
  cwd: '/local/remote-anchor',
  displayCwd: '/remote/project',
  projectId: 'project',
  projectLocation: {
    kind: 'ssh',
    hostProfileId: 'host',
    remoteRoot: '/remote/project',
    canonicalRoot: '/remote/project'
  },
  sessionGeneration: 4,
  permissionMode: 'ask',
  workMode: 'direct',
  status: 'idle',
  unreadKind: null
}

function remoteUsageOptions(
  status: CurrentSessionPayload['status'],
  readUsage: () => Promise<{ tokens: number; contextWindow: number; percent: number } | null>,
  onResolve: () => void
): CurrentContextUsageOptions {
  const record = {
    promise: Promise.resolve({ session: { getContextUsage: readUsage } })
  }
  return {
    getCurrentPayload: () => ({ ...remoteSession, status }),
    getCurrentSessionKey: () => 'phi-session:remote',
    getCurrentSessionPath: () => 'phi-session:remote',
    getCurrentCwd: () => remoteSession.cwd,
    getCurrentPermissionMode: () => remoteSession.permissionMode,
    findPhiManifestForSession: () =>
      ({
        projectLocation: remoteSession.projectLocation,
        runtimeRef: {}
      }) as unknown as NonNullable<
        ReturnType<CurrentContextUsageOptions['findPhiManifestForSession']>
      >,
    runtimeSessionPathForSnapshot: () => undefined,
    getCurrentLifecycle: () => {
      onResolve()
      return { currentRecord: record, isCurrent: () => true } as unknown as ReturnType<
        CurrentContextUsageOptions['getCurrentLifecycle']
      >
    },
    getAgentSession: async () => {
      throw new Error('Remote usage must not create a runtime')
    }
  }
}

test('a running remote conversation reports unavailable usage without querying metadata', async () => {
  let resolutions = 0
  const options = remoteUsageOptions(
    'running',
    async () => {
      throw new Error('Metadata should not be queried during a run')
    },
    () => resolutions++
  )
  const result = await getCurrentContextUsage(options)
  assert.deepEqual(result, {
    sessionPath: remoteSession.path,
    phiSessionId: remoteSession.phiSessionId,
    sessionGeneration: remoteSession.sessionGeneration,
    usage: null
  })
  assert.equal(resolutions, 0)
})

test('a remote metadata admission race is unavailable usage, while real failures still surface', async () => {
  let resolutions = 0
  for (const owner of ['Phi session', 'runtime'] as const) {
    const busy = remoteUsageOptions(
      'idle',
      async () => {
        throw new RemoteMetadataBusyError(owner)
      },
      () => resolutions++
    )
    assert.equal((await getCurrentContextUsage(busy)).usage, null)
  }
  assert.equal(resolutions, 2)

  const broken = remoteUsageOptions(
    'idle',
    async () => {
      throw new Error('Remote metadata was corrupted')
    },
    () => undefined
  )
  await assert.rejects(getCurrentContextUsage(broken), /corrupted/)
})
