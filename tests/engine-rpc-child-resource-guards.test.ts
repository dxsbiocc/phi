import { join } from 'node:path'
import { projectToolBoundaryDecision } from '../src/main/agent/engine/phi-extension/lib/project-boundary'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { resolveRpcAgentModelRefs } from '../src/main/agent/engine/rpc/subagents/definition-compiler'
import { canonicalRpcChildNativeInput } from '../src/main/agent/engine/phi-extension/extensions/rpc-child-native-tools'
import {
  assertRpcChildEnvironment,
  rpcChildEnvironmentCommand
} from '../src/main/agent/engine/phi-extension/extensions/rpc-child-environment'
import { captureApprovalHook, approvalIdentity } from './helpers/rpcApprovalFixture'
import { compileOptions, definition } from './helpers/rpcAgentDefinitionFixture'
import { createRemoteRuntimeFixture, installFakeMicromamba } from './helpers/remoteRuntimeFixture'
import { RemoteEnvironmentService } from '../src/main/agent/remote-runtime/environment-service'

test('global model lookup may exceed 4096 while only exact parent and selected expert refs are published', async () => {
  const options = compileOptions()
  const models = [
    ...Array.from({ length: 4100 }, (_, index) => ({ provider: 'unselected', id: String(index) })),
    ...options.availableModels,
    { provider: 'fixture', id: 'selected-child' }
  ]
  const chosen = await resolveRpcAgentModelRefs(
    [
      definition({
        model: ['fixture/selected-child']
      })
    ],
    models,
    options.parentModel
  )
  assert.equal(chosen.length, 2)
  assert.deepEqual(chosen[0], options.parentModel)
  assert.deepEqual(chosen[1], { provider: 'fixture', id: 'selected-child' })
})

test('main and child shell admission reject actual SDK detached/service parameters before any approval or dispatch', async () => {
  const ready = {
    ...approvalIdentity,
    cwd: realpathSync('.'),
    signal: new AbortController().signal
  }
  let approvals = 0
  const hook = await captureApprovalHook({ readiness: () => ready, classifyTool: () => 'exec' })
  const ctx = {
    cwd: ready.cwd,
    agent: { kind: 'main' as const },
    sessionManager: { getSessionId: () => ready.ompSessionId },
    ui: {
      confirm: async () => {
        approvals++
        return true
      }
    }
  }
  for (const extra of [
    { async: true },
    { background: true },
    { name: 'service' },
    { ready: { port: 3000 } }
  ]) {
    assert.throws(() =>
      canonicalRpcChildNativeInput(ready.cwd, 'bash', { command: 'echo must-not-start', ...extra })
    )
    assert.equal(
      (
        (await hook(
          {
            type: 'tool_call',
            toolCallId: 'unsafe-shell',
            toolName: 'bash',
            input: { command: 'echo must-not-start', ...extra }
          },
          ctx
        )) as { block: boolean }
      ).block,
      true
    )
  }
  assert.equal(approvals, 0)
})

test('managed native bash reuses isolated micromamba command and refuses changed ready marker before execution', async () => {
  const f = createRemoteRuntimeFixture()
  const runtimeRoot = join(f.runtimeRoot, "runtime user's root")
  mkdirSync(runtimeRoot)
  const binary = installFakeMicromamba({ ...f, runtimeRoot })
  const workspace = { ...f.workspace, runtimeRoot, micromambaPath: binary }
  const service = new RemoteEnvironmentService({
    openWorkspace: async () => workspace,
    micromambaVersion: 'test',
    confirm: async () => true,
    resolveBasePackages: async () => ['bash']
  })
  try {
    await service.request({
      runtimeSessionId: 'runtime',
      requestId: 'seed',
      environment: 'phi:python@1',
      packages: ['coreutils'],
      reason: 'tiny fixture'
    })
    const ready = await service.describeReadyInWorkspace('phi:python@1', workspace)
    assert.ok(ready?.execution)
    const environment = {
      ...ready,
      execution: ready.execution,
      binding: {
        serverId: 'fixture',
        serverIdentitySha256: 'a'.repeat(64),
        projectId: 'project',
        projectRoot: f.projectRoot
      }
    }
    assertRpcChildEnvironment(environment)
    const command = rpcChildEnvironmentCommand(environment, 'printf MANAGED_EXECUTION')
    assert.match(command, /env -i/)
    assert.match(command, /--rc-file/)
    assert.equal(projectToolBoundaryDecision(f.projectRoot, 'bash', { command }).allowed, true)
    assert.equal(
      projectToolBoundaryDecision(f.projectRoot, 'bash', {
        command: rpcChildEnvironmentCommand(environment, 'cat /etc/passwd')
      }).allowed,
      false
    )
    const result = await f.workspace.projectHost.exec.run(['sh', '-c', command], {
      cwd: f.projectRoot
    })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout, 'MANAGED_EXECUTION')
    writeFileSync(ready.execution.markerPath, 'changed')
    assert.throws(() => rpcChildEnvironmentCommand(environment, 'echo must-not-start'), /lock/)
    const refused = await f.workspace.projectHost.exec.run(['sh', '-c', command], {
      cwd: f.projectRoot
    })
    assert.notEqual(refused.code, 0)
    assert.equal(refused.stdout, '')
  } finally {
    for (const session of f.sessions) await session.close()
    f.cleanup()
  }
})
