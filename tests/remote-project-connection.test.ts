import assert from 'node:assert/strict'
import test from 'node:test'

import type { RemoteProjectConnectionState } from '../src/shared/projectLocation'
import type { Project } from '../src/main/agent/projects'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import {
  classifyRemoteProjectConnectionError,
  RemoteProjectConnectionTracker
} from '../src/main/agent/remote-project-connection'
import {
  RemoteSshConnectionError,
  sshConnectionDiagnosis
} from '../src/main/agent/wrappers/remote-ssh-diagnostics'

function fixture(resolvePath?: () => Promise<unknown>): {
  tracker: RemoteProjectConnectionTracker
  updates: RemoteProjectConnectionState[]
  requests: Array<Record<string, unknown>>
  releasedProjects: string[]
} {
  const updates: RemoteProjectConnectionState[] = []
  const requests: Array<Record<string, unknown>> = []
  const releasedProjects: string[] = []
  const project = {
    id: 'project-a',
    location: {
      kind: 'ssh',
      hostProfileId: 'host-a',
      remoteRoot: '/work',
      canonicalRoot: '/data/work'
    }
  } as Project
  const manifest = {
    sessionId: 'session-a',
    kind: 'project',
    projectId: project.id,
    projectLocation: project.location
  } as PhiSessionManifest
  const tracker = new RemoteProjectConnectionTracker({
    getProject: (id) => (id === project.id ? project : undefined),
    getManifest: (id) => (id === manifest.sessionId ? manifest : null),
    setState: (_id, state) => updates.push(state),
    releaseProjectHosts: (id) => releasedProjects.push(id),
    resolvePath: async (input) => {
      requests.push(input as Record<string, unknown>)
      await resolvePath?.()
      return { path: '/data/work' } as never
    }
  })
  return { tracker, updates, requests, releasedProjects }
}

test('switch/retry probe uses the saved session and project, then reports ready', async () => {
  const f = fixture()
  const result = await f.tracker.check('session-a', 'project-a')
  assert.deepEqual(
    f.updates.map((state) => state.phase),
    ['connecting', 'reachable']
  )
  assert.equal(result.phase, 'reachable')
  assert.deepEqual(f.requests, [
    { sessionId: 'session-a', projectId: 'project-a', path: '.', mode: 'existing' }
  ])
  await assert.rejects(f.tracker.check('other-session', 'project-a'), /会话归属无效/)
  assert.equal(f.updates.length, 2)
})

test('network, changed host key, authentication and project-root errors remain distinct', async () => {
  const cases = [
    ['network_unreachable', 'offline'],
    ['host_key_changed', 'identity_failed'],
    ['authentication_failed', 'authentication_failed'],
    ['configuration_invalid', 'configuration_failed']
  ] as const
  for (const [code, phase] of cases) {
    const f = fixture(async () => {
      throw new RemoteSshConnectionError(sshConnectionDiagnosis(code))
    })
    const status = await f.tracker.check('session-a', 'project-a')
    assert.equal(status.phase, phase)
    assert.equal(f.updates.at(-1)?.phase, phase)
    assert.equal(status.message?.includes('ssh -o'), false)
  }
  const denied = fixture(async () => {
    throw new Error('远程路径授权失败：项目根目录已变化或不可访问')
  })
  assert.equal((await denied.tracker.check('session-a', 'project-a')).phase, 'permission_failed')
})

test('a restarted server can reconnect to the same project without replaying an operation', async () => {
  let serverAvailable = false
  const f = fixture(async () => {
    if (!serverAvailable) {
      throw new RemoteSshConnectionError(sshConnectionDiagnosis('network_unreachable'))
    }
  })
  assert.equal((await f.tracker.check('session-a', 'project-a')).phase, 'offline')
  serverAvailable = true
  assert.equal((await f.tracker.check('session-a', 'project-a')).phase, 'reachable')
  assert.deepEqual(
    f.updates.map((state) => state.phase),
    ['connecting', 'offline', 'connecting', 'reachable']
  )
  assert.equal(f.requests.length, 2)
  assert.equal(
    f.requests.every((request) => request.path === '.' && request.mode === 'existing'),
    true
  )
})

test('a command error does not mean offline; unknown transport does, user cancel does not', async () => {
  const f = fixture()
  await assert.rejects(
    f.tracker.observe('project-a', async () => {
      throw new Error('exit code 1')
    })
  )
  assert.equal(f.updates.length, 0)
  await f.tracker.observe('project-a', async () => ({ status: 'completed', exitCode: 1 }))
  assert.equal(f.updates.at(-1)?.phase, 'reachable')
  await f.tracker.observe('project-a', async () => ({
    status: 'unknown',
    reason: 'connection_lost'
  }))
  assert.equal(f.updates.at(-1)?.phase, 'offline')
  assert.deepEqual(f.releasedProjects, ['project-a'])
  const beforeCancel = f.updates.length
  await f.tracker.observe('project-a', async () => ({ status: 'unknown', reason: 'cancelled' }))
  assert.equal(f.updates.length, beforeCancel)
  f.tracker.noteRemoteRunLost('project-a')
  assert.equal(f.updates.at(-1)?.phase, 'offline')
})

test('a stale connection check cannot overwrite a newer successful operation', async () => {
  let rejectOld!: (error: Error) => void
  const f = fixture(
    () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject
      })
  )
  const old = f.tracker.check('session-a', 'project-a')
  await new Promise((resolve) => setImmediate(resolve))
  await f.tracker.observe('project-a', async () => 'remote read succeeded')
  rejectOld(new RemoteSshConnectionError(sshConnectionDiagnosis('network_unreachable')))
  assert.equal((await old).phase, 'offline')
  assert.equal(f.updates.at(-1)?.phase, 'reachable')
})

test('only recognized SSH transport failures change the shared connection phase', () => {
  assert.equal(classifyRemoteProjectConnectionError(new Error('目标不存在')), null)
  assert.equal(
    classifyRemoteProjectConnectionError(new Error('SSH 调用已取消；远端命令结果可能尚未确认')),
    null
  )
  assert.equal(
    classifyRemoteProjectConnectionError(
      new Error('ssh 输出超过 1048576 字节；远端操作结果可能尚未确认')
    ),
    null
  )
  assert.equal(
    classifyRemoteProjectConnectionError(new Error('SSH 连接已关闭；结果可能未知'))?.phase,
    'offline'
  )
})
