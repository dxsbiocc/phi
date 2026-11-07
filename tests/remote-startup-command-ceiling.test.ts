import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RemoteStartupDiagnostics,
  type RemoteStartupDiagnostic
} from '../src/main/agent/engine/rpc/remote-startup-diagnostics'
import { openRemoteRuntimeWorkspace } from '../src/main/agent/remote-runtime/workspace'
import { createRemoteRuntimeFixture } from './helpers/remoteRuntimeFixture'

test('remote runtime workspace startup uses two bounded remote commands', async (t) => {
  const fixture = createRemoteRuntimeFixture()
  t.after(() => fixture.cleanup())
  let report: RemoteStartupDiagnostic | undefined
  const diagnostics = new RemoteStartupDiagnostics({
    phiSessionId: 'remote-startup-ceiling',
    emit: (value) => {
      report = value
    }
  })
  const workspace = await openRemoteRuntimeWorkspace(
    {
      runtimeSessionId: 'runtime-startup-ceiling',
      sessionId: 'session-startup-ceiling',
      projectId: 'project-startup-ceiling',
      configuredRoot: fixture.runtimeRoot
    },
    undefined,
    () => ({
      sessionId: 'session-startup-ceiling',
      projectId: 'project-startup-ceiling',
      hostAlias: 'startup-ceiling-host',
      remoteRoot: fixture.projectRoot,
      canonicalRoot: fixture.projectRoot,
      cacheKey: 'startup-ceiling-host',
      config: {
        remoteRoot: fixture.projectRoot,
        canonicalRoot: fixture.projectRoot,
        connect: async () => diagnostics.instrumentSession(await fixture.connect())
      }
    }),
    diagnostics
  )
  t.after(() => workspace.close?.())
  diagnostics.finish('ready')

  assert.ok(report)
  assert.equal(report.status, 'ready')
  assert.deepEqual(
    report.steps.map((step) => ({
      step: step.step,
      remoteCommands: step.remoteCommands,
      channels: step.channels
    })),
    [
      { step: 'platform_probe', remoteCommands: 1, channels: { openStdio: 1 } },
      { step: 'runtime_root', remoteCommands: 1, channels: { openStdio: 1 } }
    ]
  )
  assert.equal(
    report.steps.reduce((total, step) => total + step.remoteCommands, 0),
    2
  )
})
