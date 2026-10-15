import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  RemoteRuntimeController,
  type RemoteRuntimeDispatchControl
} from '../src/main/agent/remote-runtime/controller'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  readFakeMicromambaInvocations,
  writeTestSkill
} from './helpers/remoteRuntimeFixture'

const identity = { runtimeSessionId: 'runtime', remoteSessionId: 'phi', projectId: 'project' }
const request = {
  ...identity,
  requestId: 'call',
  tool: 'remotedemo_json',
  args: { message: 'owned result' }
}

async function setup(): Promise<{
  f: ReturnType<typeof createRemoteRuntimeFixture>
  runtime: RemoteRuntimeController
  ready: Promise<void>
  release(): void
  pause(): void
}> {
  const f = createRemoteRuntimeFixture()
  installFakeMicromamba(f)
  const source = writeTestSkill(f)
  const path = join(source.dir, 'SKILL.md')
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace('  toolPrefix:', '  attachTo: [Research]\n  toolPrefix:')
  )
  let hold = false,
    reached!: () => void,
    release!: () => void
  const ready = new Promise<void>((resolve) => {
    reached = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = new RemoteRuntimeController({
    micromambaVersion: 'test',
    resolveTarget: () => ({
      runtimeSessionId: 'runtime',
      sessionId: 'phi',
      projectId: 'project',
      configuredRoot: f.runtimeRoot
    }),
    listSkills: async () => [{ ...source, insidePlugin: false }],
    confirmEnvironment: async () => true,
    resolveBasePackages: async () => ['bash'],
    openWorkspace: async () => {
      if (hold) {
        reached()
        await gate
      }
      return f.workspace
    }
  })
  const seeded = await runtime.requestEnvironment({
    ...identity,
    requestId: 'seed',
    environment: 'phi:python@1',
    packages: ['coreutils'],
    reason: 'isolated owner contract'
  })
  assert.ok('envId' in seeded, JSON.stringify(seeded))
  await runtime.scriptTools(identity)
  return {
    f,
    runtime,
    ready,
    release,
    pause() {
      hold = true
    }
  }
}

function control(
  toolOwner: string,
  allowedSkills: readonly string[] = ['remote-demo']
): RemoteRuntimeDispatchControl {
  return {
    beforeDispatch() {
      return undefined
    },
    resourceOwner: { toolOwner, allowedSkills }
  }
}

test('remote declared script execution and approval use desktop owner and original attachTo', async () => {
  const { f, runtime } = await setup()
  try {
    assert.equal(runtime.approvalFor(request.tool, request, control('Research')), 'read')
    assert.throws(
      () =>
        runtime.approvalFor(
          request.tool,
          { ...request, attachTo: ['Other'], toolOwner: 'Research' },
          control('Other')
        ),
      /not attached/
    )
    assert.throws(() => runtime.approvalFor(request.tool, request), /not attached to 'main'/)
    const before = readFakeMicromambaInvocations(f)
    const refused = await runtime.runScriptTool(
      { ...request, toolOwner: 'Research', attachTo: ['Other'] },
      control('Other')
    )
    assert.equal(refused.ok, false)
    assert.match(refused.error!, /not attached/)
    assert.deepEqual(readFakeMicromambaInvocations(f), before)
    const accepted = await runtime.runScriptTool(request, control('Research'))
    assert.equal(accepted.ok, true)
    const after = readFakeMicromambaInvocations(f)
    assert.equal(after.length, before.length + 1)
    assert.ok(after.at(-1)?.argv.includes('run'))
  } finally {
    f.cleanup()
  }
})

test('wire allowedSkills cannot broaden desktop captured skill authority', async () => {
  const { f, runtime } = await setup()
  try {
    const owner = control('Research', [])
    const raw = {
      ...identity,
      requestId: 'raw',
      skill: 'remote-demo',
      script: 'run.sh',
      allowedSkills: ['remote-demo']
    }
    const before = readFakeMicromambaInvocations(f)
    assert.throws(() => runtime.approvalFor('skill_run', raw, owner), /not allowed/)
    await assert.rejects(runtime.runSkill(raw, owner), /not allowed/)
    assert.equal(
      (await runtime.runScriptTool({ ...request, allowedSkills: ['remote-demo'] }, owner)).ok,
      false
    )
    assert.deepEqual(readFakeMicromambaInvocations(f), before)
  } finally {
    f.cleanup()
  }
})

test('interleaved dispatch retains its own immutable resource owner across workspace preparation', async () => {
  const { f, runtime, pause, ready, release } = await setup()
  try {
    const skills = ['remote-demo']
    pause()
    const accepted = runtime.runScriptTool(request, control('Research', skills))
    await ready
    skills.splice(0)
    const peer = await runtime.runScriptTool({ ...request, requestId: 'peer' }, control('Other'))
    assert.equal(peer.ok, false)
    assert.match(peer.error!, /not attached/)
    release()
    assert.equal((await accepted).ok, true)
  } finally {
    release()
    f.cleanup()
  }
})

test('retired desktop owner rejects approval and execution before touching remote runtime', async () => {
  const { f, runtime } = await setup()
  try {
    const before = readFakeMicromambaInvocations(f)
    const retired = {
      ...control('Research'),
      beforeDispatch() {
        throw new Error('child ownership retired')
      }
    }
    assert.throws(() => runtime.approvalFor(request.tool, request, retired), /ownership retired/)
    const refused = await runtime.runScriptTool(request, retired)
    assert.equal(refused.ok, false)
    assert.match(refused.error!, /ownership retired/)
    assert.deepEqual(readFakeMicromambaInvocations(f), before)
  } finally {
    f.cleanup()
  }
})
