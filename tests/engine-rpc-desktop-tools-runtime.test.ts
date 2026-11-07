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

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

const identity = {
  runtimeSessionId: 'runtime-session',
  remoteSessionId: 'phi-session',
  projectId: 'project'
}

test(
  'real skills and environment services use only the selected remote runtime workspace',
  { timeout: 60_000 },
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
          input.runtimeSessionId !== identity.runtimeSessionId ||
          input.remoteSessionId !== identity.remoteSessionId ||
          input.projectId !== identity.projectId
        )
          return undefined
        return {
          runtimeSessionId: identity.runtimeSessionId,
          sessionId: identity.remoteSessionId,
          projectId: identity.projectId,
          configuredRoot: server.runtimeRoot
        }
      },
      listSkills: async () => [{ ...skill, insidePlugin: false }],
      confirmEnvironment: async () => true,
      resolveBasePackages: async () => ['bash'],
      openWorkspace: async (target) => {
        assert.equal(target.projectId, identity.projectId)
        assert.equal(target.sessionId, identity.remoteSessionId)
        opened++
        return server.workspace
      }
    })

    const descriptors = await controller.scriptTools(identity)
    assert.deepEqual(descriptors.problems, [])
    assert.ok(descriptors.tools.some((tool) => tool.name === 'remotedemo_write'))

    const environment = await controller.requestEnvironment({
      ...identity,
      requestId: 'environment-call',
      environment: 'phi:python@1',
      packages: ['coreutils'],
      reason: 'Synthetic selected remote environment fixture'
    })
    assert.equal('error' in environment, false, JSON.stringify(environment))

    const run = await controller.runSkill({
      ...identity,
      requestId: 'skill-call',
      skill: 'remote-demo',
      script: 'run.sh',
      args: ['from-rpc'],
      allowedSkills: ['remote-demo']
    })
    assert.equal('notReady' in run, false, JSON.stringify(run))
    if ('notReady' in run) return
    assert.equal(run.exitCode, 0)
    assert.match(run.stdout, /from-rpc/)

    const dynamicInput = {
      ...identity,
      requestId: 'dynamic-call',
      tool: 'remotedemo_write',
      args: { output: 'rpc-proof.txt', content: 'selected server bytes' }
    }
    assert.equal(controller.approvalFor('remotedemo_write', dynamicInput), 'write')
    const dynamic = await controller.runScriptTool(dynamicInput)
    assert.equal(dynamic.ok, true, JSON.stringify(dynamic))
    assert.equal(
      readFileSync(join(server.projectRoot, 'rpc-proof.txt'), 'utf8'),
      'selected server bytes'
    )
    assert.equal(existsSync(join(server.localAnchor, 'rpc-proof.txt')), false)
    assert.ok(opened > 0)
  }
)

test('an invalid remote runtime binding is denied without local execution', () => {
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
  assert.throws(
    () => controller.runSkill({
      ...identity,
      requestId: 'invalid-call',
      skill: 'remote-demo',
      script: 'run.sh',
      args: []
    }),
    /No local execution fallback was used/
  )
  assert.equal(opens, 0)
})
