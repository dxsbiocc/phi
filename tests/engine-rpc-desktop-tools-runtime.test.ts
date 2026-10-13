import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { RemoteRuntimeController } from '../src/main/agent/remote-runtime/controller'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  writeTestSkill
} from './helpers/remoteRuntimeFixture'
import { desktopToolsFixture } from './helpers/rpcDesktopToolsFixture'

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

test(
  'real skills/environment builders route through the selected RemoteRuntimeController and WorkspaceHost',
  { timeout: 60000 },
  async (t) => {
    const server = createRemoteRuntimeFixture()
    t.after(() => server.cleanup())
    installFakeMicromamba(server)
    const skill = writeTestSkill(server)
    let opened = 0
    const controller = new RemoteRuntimeController({
      micromambaVersion: 'test',
      resolveTarget: (value) => {
        const input = record(value)
        if (
          input.runtimeSessionId !== 'runtime-session' ||
          input.remoteSessionId !== 'phi-session' ||
          input.projectId !== 'project'
        )
          return undefined
        return {
          runtimeSessionId: 'runtime-session',
          sessionId: 'phi-session',
          projectId: 'project',
          configuredRoot: server.runtimeRoot
        }
      },
      listSkills: async () => [{ ...skill, insidePlugin: false }],
      confirmEnvironment: async () => true,
      resolveBasePackages: async () => ['bash'],
      openWorkspace: async (target) => {
        assert.equal(target.projectId, 'project')
        assert.equal(target.sessionId, 'phi-session')
        opened++
        return server.workspace
      }
    })
    const identity = {
      runtimeSessionId: 'runtime-session',
      remoteSessionId: 'phi-session',
      projectId: 'project'
    }
    const descriptors = await controller.scriptTools(identity)
    assert.deepEqual(descriptors.problems, [])
    const f = desktopToolsFixture({
      cwd: server.projectRoot,
      scriptTools: descriptors.tools,
      scriptApprovalFor: (name, input) => controller.approvalFor(name, input)
    })
    t.after(() => f.close())
    const dispatch = (method: string, value: unknown): Promise<unknown> => {
      assert.equal(controller.owns(value), true)
      if (method === 'skills.run') return controller.runSkill(value)
      if (method === 'skills.scriptTool') return controller.runScriptTool(value)
      return controller.requestEnvironment(value)
    }
    for (const method of ['skills.run', 'skills.scriptTool', 'environments.request'])
      f.services.register(method, (params, context) => {
        assert.equal(context.originSessionId, 'runtime-session')
        assert.ok(context.toolCallId)
        assert.equal(record(params).cwd, server.projectRoot)
        assert.equal(record(params).remoteSessionId, 'phi-session')
        assert.equal(record(params).projectId, 'project')
        return dispatch(method, params)
      })
    f.services.register('skills.cancel', (params) => controller.skills.cancel(params))
    f.services.register('environments.cancel', (params) => controller.environments.cancel(params))
    const environment = await f.call('env_request', {
      environment: 'phi:python@1',
      packages: ['coreutils'],
      reason: 'Synthetic selected remote environment fixture'
    })
    assert.equal(environment.isError, undefined, JSON.stringify(environment))
    const run = await f.call('skill_run', {
      skill: 'remote-demo',
      script: 'run.sh',
      args: ['from-rpc']
    })
    assert.equal(run.isError, undefined, JSON.stringify(run))
    assert.equal(record(run.details).exitCode, 0)
    assert.match(String(record(run.details).stdout), /from-rpc/)
    const dynamic = await f.call('remotedemo_write', {
      output: 'rpc-proof.txt',
      content: 'selected server bytes'
    })
    assert.equal(
      f.scope.approvalFor('remotedemo_write', {
        output: 'rpc-proof.txt',
        content: 'selected server bytes'
      }),
      'write'
    )
    assert.equal(dynamic.isError, undefined, JSON.stringify(dynamic))
    assert.equal(
      readFileSync(join(server.projectRoot, 'rpc-proof.txt'), 'utf8'),
      'selected server bytes'
    )
    assert.equal(existsSync(join(server.localAnchor, 'rpc-proof.txt')), false)
    assert.ok(opened > 0)
  }
)

test('an invalid remote runtime binding fails through existing controller without any local execution', async (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  let opens = 0
  const controller = new RemoteRuntimeController({
    micromambaVersion: 'test',
    resolveTarget: () => undefined,
    listSkills: async () => [],
    confirmEnvironment: async () => false,
    openWorkspace: async () => {
      opens++
      throw new Error('must not open')
    }
  })
  f.services.register('skills.run', (params) => {
    controller.owns(params)
    return controller.runSkill(params)
  })
  const result = await f.call('skill_run', { skill: 'remote-demo', script: 'run.sh' })
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result.content), /没有回退/)
  assert.equal(opens, 0)
})
