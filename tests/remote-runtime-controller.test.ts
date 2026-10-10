import assert from 'node:assert/strict'
import test from 'node:test'

import { RemoteRuntimeController } from '../src/main/agent/remote-runtime/controller'
import type { RemoteRuntimeTarget } from '../src/main/agent/remote-runtime/workspace'

function target(params: unknown): RemoteRuntimeTarget | undefined {
  const record = params as Record<string, unknown>
  if (
    typeof record.runtimeSessionId !== 'string' ||
    typeof record.remoteSessionId !== 'string' ||
    typeof record.projectId !== 'string'
  ) {
    return undefined
  }
  return {
    runtimeSessionId: record.runtimeSessionId,
    sessionId: record.remoteSessionId,
    projectId: record.projectId,
    configuredRoot: '/runtime'
  }
}

function controller(): RemoteRuntimeController {
  return new RemoteRuntimeController({
    micromambaVersion: 'test',
    resolveTarget: target,
    listSkills: async () => [],
    confirmEnvironment: async () => true,
    openWorkspace: async () => {
      throw new Error('not used')
    }
  })
}

test('remote runtime routing rejects malformed identity instead of falling back local', () => {
  const runtime = controller()
  assert.equal(runtime.owns({ runtimeSessionId: 'local-runtime' }), false)
  assert.throws(
    () => runtime.owns({ runtimeSessionId: 'remote-runtime', remoteSessionId: 'session-1' }),
    /没有回退到本机/u
  )
  assert.throws(
    () =>
      runtime.owns({
        runtimeSessionId: 'remote-runtime',
        remoteSessionId: 42,
        projectId: null
      }),
    /没有回退到本机/u
  )
})

test('remote runtime identity is immutable for one runtime session', () => {
  const runtime = controller()
  assert.equal(
    runtime.owns({
      runtimeSessionId: 'runtime-1',
      remoteSessionId: 'session-1',
      projectId: 'project-1'
    }),
    true
  )
  assert.throws(
    () =>
      runtime.owns({
        runtimeSessionId: 'runtime-1',
        remoteSessionId: 'session-2',
        projectId: 'project-2'
      }),
    /身份发生变化/u
  )
})
