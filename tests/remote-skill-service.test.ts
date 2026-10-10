import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { RemoteEnvironmentService } from '../src/main/agent/remote-runtime/environment-service'
import { RemoteSkillService } from '../src/main/agent/remote-runtime/skill-service'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  writeTestSkill
} from './helpers/remoteRuntimeFixture'
import { countWorkspaceHostOperations } from './helpers/countingWorkspaceHost'

interface ServiceSetup {
  fixture: ReturnType<typeof createRemoteRuntimeFixture>
  skill: ReturnType<typeof writeTestSkill>
  environments: RemoteEnvironmentService
  environment: { ref: string; envId: string; name: string; added: string[] }
  skillService: RemoteSkillService
}

const SKILL_HOST_OPERATION_BASELINE = {
  firstUpload: 25,
  reuse: 24,
  dynamicScript: 20
} as const

const SKILL_HOST_OPERATION_LIMIT = 8

async function services(
  options: { sleeper?: boolean; noisy?: boolean; maxOutputBytes?: number } = {}
): Promise<ServiceSetup> {
  const fixture = createRemoteRuntimeFixture()
  installFakeMicromamba(fixture)
  const skill = writeTestSkill(fixture, options)
  const environments = new RemoteEnvironmentService({
    micromambaVersion: 'test',
    openWorkspace: async () => fixture.workspace,
    confirm: async () => true,
    resolveBasePackages: async () => ['bash']
  })
  const environment = await environments.request({
    requestId: 'prepare-environment',
    runtimeSessionId: 'runtime-1',
    cwd: fixture.localAnchor,
    packages: ['coreutils'],
    reason: 'run the remote skill',
    environment: 'phi:python@1'
  })
  assert.ok('envId' in environment)
  const skillService = new RemoteSkillService({
    openWorkspace: async () => fixture.workspace,
    environments,
    listSkills: async () => [{ ...skill, insidePlugin: false }],
    ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {})
  })
  return { fixture, skill, environments, environment, skillService }
}

function runRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'skill-request-1',
    runtimeSessionId: 'runtime-1',
    cwd: '/local/anchor-that-must-not-be-used',
    skill: 'remote-demo',
    script: 'run.sh',
    args: ['hello'],
    ...overrides
  }
}

test('remote skill paths report WorkspaceHost operation baselines', async (t) => {
  const setup = await services()
  mkdirSync(join(setup.skill.dir, 'assets'))
  writeFileSync(join(setup.skill.dir, 'assets', 'binary.bin'), Buffer.from([0, 255, 1, 2]))
  const counter = countWorkspaceHostOperations(setup.fixture.workspace)
  try {
    const first = await setup.skillService.run(runRequest({ requestId: 'count-first' }))
    assert.equal(first.exitCode, 0)
    const firstUpload = counter.snapshot()
    counter.reset()

    const reused = await setup.skillService.run(runRequest({ requestId: 'count-reuse' }))
    assert.equal(reused.exitCode, 0)
    const reuse = counter.snapshot()
    counter.reset()

    await setup.skillService.scriptTools({ runtimeSessionId: 'runtime-1' })
    const dynamic = await setup.skillService.scriptTool({
      requestId: 'count-dynamic',
      runtimeSessionId: 'runtime-1',
      tool: 'remotedemo_json',
      args: { message: 'count' }
    })
    assert.equal(dynamic.ok, true)
    const dynamicScript = counter.snapshot()

    assertHostOperationLimit(
      'skill first upload',
      firstUpload,
      SKILL_HOST_OPERATION_BASELINE.firstUpload
    )
    assertHostOperationLimit('skill reuse', reuse, SKILL_HOST_OPERATION_BASELINE.reuse)
    assertHostOperationLimit(
      'dynamic script',
      dynamicScript,
      SKILL_HOST_OPERATION_BASELINE.dynamicScript
    )
    t.diagnostic(`skill first upload host operations: ${JSON.stringify(firstUpload)}`)
    t.diagnostic(`skill reuse host operations: ${JSON.stringify(reuse)}`)
    t.diagnostic(`dynamic script host operations: ${JSON.stringify(dynamicScript)}`)
  } finally {
    setup.fixture.cleanup()
  }
})

function assertHostOperationLimit(
  label: string,
  actual: { total: number },
  baseline: number
): void {
  assert.ok(
    actual.total <= SKILL_HOST_OPERATION_LIMIT,
    `${label}: ${actual.total} host operations exceeds ${SKILL_HOST_OPERATION_LIMIT} (baseline ${baseline})`
  )
}

test('remote skill_run uploads one content-addressed bundle and reuses it', async () => {
  const setup = await services()
  try {
    mkdirSync(join(setup.skill.dir, 'assets'))
    writeFileSync(join(setup.skill.dir, 'assets', 'binary.bin'), Buffer.from([0, 255, 1, 2]))
    let publications = 0
    const original = setup.fixture.workspace.execWithInput
    setup.fixture.workspace.execWithInput = async (...args) => {
      if (args[0].includes('phi_decode()')) publications += 1
      return original(...args)
    }
    const first = await setup.skillService.run(runRequest())
    const publicationsAfterFirst = publications
    const second = await setup.skillService.run(runRequest({ requestId: 'skill-request-2' }))
    assert.equal(first.exitCode, 0)
    assert.match(
      first.stdout,
      new RegExp(`^${escapeRegExp(setup.fixture.projectRoot)}\\|hello\\|dependency$`)
    )
    assert.equal(second.exitCode, 0)
    assert.ok(publicationsAfterFirst > 0)
    assert.equal(publications, publicationsAfterFirst)
    const bundle = assertedBundle(setup.fixture.runtimeRoot)
    assert.deepEqual(
      readFileSync(join(setup.fixture.runtimeRoot, 'skills', bundle, 'assets', 'binary.bin')),
      Buffer.from([0, 255, 1, 2])
    )
    await assertRepairsBundle(setup, bundle, () => publications)
    assert.equal(
      setup.fixture.sessions.some((session) =>
        session.commands.join('\n').includes(setup.fixture.localAnchor)
      ),
      false
    )
    assert.equal(existsSync(join(setup.fixture.localAnchor, 'started.pid')), false)
  } finally {
    setup.fixture.cleanup()
  }
})

test('remote dynamic skill tool executes in the remote project and returns JSON', async () => {
  const setup = await services()
  try {
    const listed = await setup.skillService.scriptTools({ runtimeSessionId: 'runtime-1' })
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ['remotedemo_json', 'remotedemo_write']
    )
    assert.equal(setup.skillService.approvalFor('remotedemo_json', { message: 'hi' }), 'read')
    assert.equal(
      setup.skillService.approvalFor('remotedemo_write', {
        output: 'result.txt',
        content: 'hi'
      }),
      'write'
    )
    const result = await setup.skillService.scriptTool({
      requestId: 'script-tool-1',
      runtimeSessionId: 'runtime-1',
      cwd: setup.fixture.localAnchor,
      tool: 'remotedemo_json',
      args: { message: 'hello' }
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.output, { message: 'hello', cwd: setup.fixture.projectRoot })
    }
  } finally {
    setup.fixture.cleanup()
  }
})

test('concurrent first runs serialize one remote bundle publication', async () => {
  const setup = await services()
  try {
    const [first, second] = await Promise.all([
      setup.skillService.run(runRequest({ requestId: 'parallel-1' })),
      setup.skillService.run(runRequest({ requestId: 'parallel-2' }))
    ])
    assert.equal(first.exitCode, 0)
    assert.equal(second.exitCode, 0)
    assert.equal(readdirSync(join(setup.fixture.runtimeRoot, 'skills')).length, 1)
  } finally {
    setup.fixture.cleanup()
  }
})

test('remote skill_run cancellation terminates the WorkspaceHost process group', async () => {
  const setup = await services({ sleeper: true })
  try {
    const pending = setup.skillService.run(runRequest())
    const pidPath = join(setup.fixture.projectRoot, 'started.pid')
    const pid = Number(await waitForFile(pidPath))
    setup.skillService.cancel({ requestId: 'skill-request-1' })
    const result = await pending
    assert.equal(result.terminated, 'aborted')
    assert.equal(processExists(pid), false)
    assert.equal(existsSync(join(setup.fixture.localAnchor, 'started.pid')), false)
  } finally {
    setup.fixture.cleanup()
  }
})

test('remote dynamic skill cancellation terminates the WorkspaceHost process group', async () => {
  const setup = await services({ sleeper: true })
  try {
    await setup.skillService.scriptTools({ runtimeSessionId: 'runtime-1' })
    const pending = setup.skillService.scriptTool({
      requestId: 'dynamic-skill-request-1',
      runtimeSessionId: 'runtime-1',
      tool: 'remotedemo_json',
      args: { message: 'sleep' }
    })
    const pidPath = join(setup.fixture.projectRoot, 'dynamic-started.pid')
    const pid = Number(await waitForFile(pidPath))
    setup.skillService.cancel({ requestId: 'dynamic-skill-request-1' })
    const result = await pending

    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error, 'aborted')
    assert.equal(processExists(pid), false)
    assert.equal(existsSync(join(setup.fixture.localAnchor, 'dynamic-started.pid')), false)
  } finally {
    setup.fixture.cleanup()
  }
})

test('remote skill_run reports bounded output truncation', async () => {
  const setup = await services({ noisy: true, maxOutputBytes: 128 })
  try {
    const result = await setup.skillService.run(runRequest())

    assert.equal(result.exitCode, 0)
    assert.equal(result.truncated.stdout, true)
    assert.equal(result.truncated.stderr, true)
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 128)
  } finally {
    setup.fixture.cleanup()
  }
})

test('remote skill_run passes shell metacharacters as argv without injection', async () => {
  const setup = await services()
  try {
    const marker = join(setup.fixture.projectRoot, 'injected.txt')
    const argument = `$(touch ${marker}); value with spaces`

    const result = await setup.skillService.run(runRequest({ args: [argument] }))

    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /\$\(touch .*injected\.txt\); value with spaces/u)
    assert.equal(existsSync(marker), false)
  } finally {
    setup.fixture.cleanup()
  }
})

test('remote dynamic project-path refuses a symlink that escapes the project', async () => {
  const setup = await services()
  try {
    await setup.skillService.scriptTools({ runtimeSessionId: 'runtime-1' })
    const outside = join(setup.fixture.root, 'outside-output.txt')
    writeFileSync(outside, 'untouched')
    symlinkSync(outside, join(setup.fixture.projectRoot, 'output.txt'))

    const result = await setup.skillService.scriptTool({
      requestId: 'script-tool-symlink',
      runtimeSessionId: 'runtime-1',
      tool: 'remotedemo_write',
      args: { output: 'output.txt', content: 'changed' }
    })

    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /outside|符号链接|project-path/u)
    assert.equal(readFileSync(outside, 'utf8'), 'untouched')
  } finally {
    setup.fixture.cleanup()
  }
})

test('remote dynamic input-path resolves only inside the remote project', async () => {
  const setup = await services()
  try {
    await setup.skillService.scriptTools({ runtimeSessionId: 'runtime-1' })
    writeFileSync(join(setup.fixture.projectRoot, 'input.txt'), 'remote input')
    const remote = await setup.skillService.scriptTool({
      requestId: 'script-tool-input',
      runtimeSessionId: 'runtime-1',
      tool: 'remotedemo_write',
      args: { output: 'output.txt', content: 'written', input: 'input.txt' }
    })
    assert.equal(remote.ok, true)
    if (remote.ok) {
      assert.equal(remote.output.input, join(setup.fixture.projectRoot, 'input.txt'))
    }

    const local = await setup.skillService.scriptTool({
      requestId: 'script-tool-local-input',
      runtimeSessionId: 'runtime-1',
      tool: 'remotedemo_write',
      args: { output: 'other.txt', content: 'blocked', input: setup.fixture.localAnchor }
    })
    assert.equal(local.ok, false)
    if (!local.ok) assert.match(local.error, /项目相对路径.*没有回退/u)
    assert.equal(existsSync(join(setup.fixture.localAnchor, 'other.txt')), false)
  } finally {
    setup.fixture.cleanup()
  }
})

test('remote skill paths reject traversal, local absolute inputs, and escaping symlinks', async () => {
  const setup = await services()
  try {
    await assert.rejects(
      () => setup.skillService.run(runRequest({ script: '../outside.sh' })),
      /scripts/u
    )
    await assert.rejects(
      () => setup.skillService.run(runRequest({ args: [setup.fixture.localAnchor] })),
      /项目相对路径.*没有回退/u
    )
    const outside = join(setup.fixture.root, 'outside.txt')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, join(setup.skill.dir, 'scripts', 'escape.txt'))
    await assert.rejects(
      () => setup.skillService.run(runRequest({ requestId: 'skill-request-escape' })),
      /符号链接/u
    )
    assert.equal(readFileSync(outside, 'utf8'), 'outside')
  } finally {
    setup.fixture.cleanup()
  }
})

test('remote skill execution never falls back when the environment marker disappears', async () => {
  const setup = await services()
  try {
    const marker = join(
      setup.fixture.runtimeRoot,
      'envs',
      setup.environment.envId,
      '.phi-remote-env.json'
    )
    writeFileSync(join(setup.fixture.localAnchor, 'sentinel.txt'), 'untouched')
    await setup.fixture.workspace.runtimeHost.fs.remove(
      join('envs', setup.environment.envId, '.phi-remote-env.json')
    )

    const result = await setup.skillService.run(runRequest())

    assert.ok('notReady' in result)
    assert.match(result.notReady.message, /env_request/u)
    assert.equal(existsSync(marker), false)
    assert.equal(readFileSync(join(setup.fixture.localAnchor, 'sentinel.txt'), 'utf8'), 'untouched')
  } finally {
    setup.fixture.cleanup()
  }
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function assertedBundle(runtimeRoot: string): string {
  const bundles = readdirSync(join(runtimeRoot, 'skills'))
  assert.equal(bundles.length, 1)
  const bundle = bundles[0] ?? ''
  assert.match(bundle, /^[a-f0-9]{64}$/u)
  assert.equal(statSync(join(runtimeRoot, 'skills', bundle)).mode & 0o777, 0o700)
  assert.equal(statSync(join(runtimeRoot, 'skills', bundle, 'scripts')).mode & 0o777, 0o700)
  assert.equal(
    statSync(join(runtimeRoot, 'skills', bundle, 'scripts', 'run.sh')).mode & 0o777,
    0o755
  )
  return bundle
}

async function assertRepairsBundle(
  setup: ServiceSetup,
  bundle: string,
  publications: () => number
): Promise<void> {
  await setup.fixture.workspace.runtimeHost.fs.remove(
    join('skills', bundle, 'scripts', 'data', 'value.txt')
  )
  const beforeRepair = publications()
  const repaired = await setup.skillService.run(runRequest({ requestId: 'skill-request-repair' }))
  assert.equal(repaired.exitCode, 0)
  assert.ok(publications() > beforeRepair)
  writeFileSync(
    join(setup.fixture.runtimeRoot, 'skills', bundle, 'scripts', 'data', 'value.txt'),
    'XXXXXXXXXX'
  )
  const tampered = await setup.skillService.run(runRequest({ requestId: 'skill-request-tamper' }))
  assert.equal(tampered.exitCode, 0)
  assert.match(tampered.stdout, /dependency$/u)
  chmodSync(join(setup.fixture.runtimeRoot, 'skills', bundle, 'scripts'), 0o755)
  const permissionRepair = await setup.skillService.run(
    runRequest({ requestId: 'skill-request-permission' })
  )
  assert.equal(permissionRepair.exitCode, 0)
  assert.equal(
    statSync(join(setup.fixture.runtimeRoot, 'skills', bundle, 'scripts')).mode & 0o777,
    0o700
  )
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const value = existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
    if (value) return value
    await delay(20)
  }
  throw new Error(`timed out waiting for ${path}`)
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
