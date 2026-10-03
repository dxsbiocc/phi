import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createEnvironmentBindingExtension } from '../src/main/agent/agents/environment-binding'
import { createEnvironmentBuilds } from '../src/main/agent/content/environment-builds'
import { bindAgentSession } from '../src/main/agent/content/environment-gate'
import {
  buildEnvironment,
  describeEnvironment,
  readyEnvironment
} from '../src/main/agent/content/environment-refs'
import { requestProjectEnvironment } from '../src/main/agent/content/env-request'
import {
  buildEnvRequestTool,
  type EnvRequestBinding
} from '../src/main/agent/content/env-request-tool'
import { createSkillHost } from '../src/main/agent/content/skill-host'
import { runSkillScript } from '../src/main/agent/content/skill-run'
import { buildScriptTools, buildSkillRunTool } from '../src/main/agent/content/skill-tools'
import {
  currentPlatform,
  parseEnvironmentSpec,
  removeTree,
  runInEnvironment,
  type EnvironmentSpec,
  type PhiPlatform
} from '../src/main/agent/envs'
import { getMicromambaPath } from '../src/main/agent/envs/paths'
import { findPlatform } from '../src/main/agent/envs/platform'
import type { SolveExplicitLockInput } from '../src/main/agent/envs/solve'
import { copyMinimal, envIdFor, installReady, shell, skillStub } from './helpers/fakeEnvironment'
import { createTestRuntimeRoot } from './helpers/testRuntimeRoot'

const FIXTURE = join(process.cwd(), 'tests/fixtures/envs/minimal')

const BASE_SPEC = `name: phi-python
channels:
  - conda-forge
dependencies:
  - python=3.12
description: base python
host:
  - name: python
    description: CPython
sourcePackages:
  - language: r
    name: ggplot2
    source: cran
    ref: 3.5.0
    sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
`

interface Harness {
  project: string
  environmentsDir: string
  platform: PhiPlatform
  questions: string[]
  solved: SolveExplicitLockInput[]
  started: string[]
  confirm: boolean
  failSolve?: string
}

function lockText(platform: string): string {
  return readFileSync(join(FIXTURE, 'locks', `${platform}.txt`), 'utf8')
}

function writePhiBase(environmentsDir: string): void {
  const dir = join(environmentsDir, 'phi-python')
  mkdirSync(join(dir, 'locks'), { recursive: true })
  writeFileSync(join(dir, 'environment.yml'), BASE_SPEC)
  cpSync(join(FIXTURE, 'locks'), join(dir, 'locks'), { recursive: true })
}

function harness(): Harness {
  const project = mkdtempSync(join(tmpdir(), 'phi-env-request-'))
  const environmentsDir = join(project, 'bundled')
  const platform = currentPlatform()
  writePhiBase(environmentsDir)
  const state: Harness = {
    project,
    environmentsDir,
    platform,
    questions: [],
    solved: [],
    started: [],
    confirm: true
  }
  return state
}

function remove(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

async function request(
  state: Harness,
  params: Record<string, unknown>
): Promise<Awaited<ReturnType<typeof requestProjectEnvironment>>> {
  return requestProjectEnvironment(
    {
      runtimeSessionId: 'runtime-1',
      cwd: state.project,
      environment: 'phi:python@1',
      ...params
    },
    {
      platform: state.platform,
      environmentsDir: state.environmentsDir,
      confirm: async (asked) => {
        state.questions.push(asked.question)
        return state.confirm
      },
      solve: async (input) => {
        state.solved.push(input)
        if (state.failSolve) throw new Error(state.failSolve)
        return lockText(state.platform)
      },
      builds: {
        list: () => [],
        cancel() {
          return undefined
        },
        async start(descriptor, options) {
          assert.equal(existsSync(join(state.project, '.phi', 'environments.json')), true)
          state.started.push(options.ref)
          return {
            envId: `built-${descriptor.spec.name}`,
            prefix: join(state.project, 'prefix'),
            metadata: descriptor as never
          }
        }
      }
    }
  )
}

function readProjectSpec(project: string, name: string): EnvironmentSpec {
  const text = readFileSync(join(project, '.phi', 'environments', name, 'environment.yml'), 'utf8')
  const parsed = parseEnvironmentSpec(text)
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join('; '))
  if (!parsed.ok) throw new Error('spec')
  return parsed.spec
}

test('env_request rejects invalid packages, reasons, and references', async () => {
  const state = harness()
  try {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ packages: [], reason: 'because' }, /1 to 20/],
      [
        {
          packages: Array.from({ length: 21 }, (_item, index) => `pkg${index}`),
          reason: 'because'
        },
        /1 to 20/
      ],
      [{ packages: ['conda-forge::six'], reason: 'because' }, /channel prefixes/],
      [{ packages: ['pip'], reason: 'because' }, /pip/],
      [{ packages: ['pip=24'], reason: 'because' }, /pip/],
      [{ packages: ['six;rm'], reason: 'because' }, /invalid conda match spec/],
      [{ packages: ['six'], reason: '   ' }, /reason/],
      [{ packages: ['six'], reason: 'x'.repeat(501) }, /reason/],
      [{ packages: ['six'], reason: 'because', environment: './environment.yml' }, /phi:<name>/]
    ]
    for (const [params, pattern] of cases) {
      const result = await request(state, params)
      assert.ok('error' in result, JSON.stringify(result))
      if ('error' in result) assert.match(result.error, pattern)
    }
    assert.deepEqual(state.questions, [])
    assert.equal(state.solved.length, 0)
    assert.equal(existsSync(join(state.project, '.phi')), false)

    state.confirm = false
    const accepted = await request(state, { packages: ['name>=1.2,<2'], reason: 'bounds' })
    assert.deepEqual(accepted, { declined: true })
    assert.equal(state.questions.length, 1)
  } finally {
    remove(state.project)
  }
})

test('a declined env_request and a failed solve write nothing', async () => {
  const state = harness()
  try {
    state.confirm = false
    const declined = await request(state, { packages: ['six'], reason: 'need six' })
    assert.deepEqual(declined, { declined: true })
    assert.equal(state.solved.length, 0)
    assert.equal(existsSync(join(state.project, '.phi', 'environments')), false)

    state.confirm = true
    state.failSolve = 'solver\nblew up'
    const failed = await request(state, { packages: ['six'], reason: 'need six' })
    assert.deepEqual(failed, { error: 'solver blew up' })
    assert.equal(state.started.length, 0)
    assert.equal(existsSync(join(state.project, '.phi', 'environments')), false)
    assert.equal(existsSync(join(state.project, '.phi', 'environments.json')), false)
  } finally {
    remove(state.project)
  }
})

test('env_request writes a project environment, then builds it, and a second request extends it', async () => {
  const state = harness()
  try {
    const first = await request(state, { packages: ['six'], reason: 'need six' })
    assert.deepEqual(first, {
      ref: 'project:python-x1',
      envId: 'built-python-x1',
      name: 'python-x1',
      added: ['six']
    })
    assert.deepEqual(state.questions, ['向环境 phi:python@1 添加 six。原因：need six'])
    assert.equal(state.solved.length, 1)
    const solved = state.solved[0]
    assert.ok(solved)
    assert.equal(solved.condaOverrides, undefined)
    assert.equal(solved.spec.name, 'python-x1')
    assert.deepEqual(solved.spec.channels, ['conda-forge'])
    assert.deepEqual(solved.spec.dependencies, ['python=3.12', 'six'])
    assert.equal(solved.spec.description, 'base python')
    assert.deepEqual(solved.spec.host, [{ name: 'python', description: 'CPython' }])
    assert.equal(solved.spec.sourcePackages?.[0]?.name, 'ggplot2')
    assert.deepEqual(state.started, ['project:python-x1'])

    const spec = readProjectSpec(state.project, 'python-x1')
    assert.equal(spec.name, 'python-x1')
    assert.deepEqual(spec.dependencies, ['python=3.12', 'six'])
    assert.deepEqual(spec.channels, ['conda-forge'])
    assert.equal(spec.description, 'base python')
    assert.deepEqual(spec.host, [{ name: 'python', description: 'CPython' }])
    assert.equal(spec.sourcePackages?.[0]?.name, 'ggplot2')
    assert.equal(
      readFileSync(
        join(state.project, '.phi', 'environments', 'python-x1', 'locks', `${state.platform}.txt`),
        'utf8'
      ),
      lockText(state.platform)
    )
    assert.deepEqual(
      JSON.parse(readFileSync(join(state.project, '.phi', 'environments.json'), 'utf8')),
      {
        version: 1,
        overrides: { 'phi:python@1': 'project:python-x1' }
      }
    )

    const second = await request(state, { packages: ['requests'], reason: 'http' })
    assert.deepEqual(second, {
      ref: 'project:python-x2',
      envId: 'built-python-x2',
      name: 'python-x2',
      added: ['requests']
    })
    assert.deepEqual(state.questions[1], '向环境 project:python-x1 添加 requests。原因：http')
    const extended = state.solved[1]
    assert.ok(extended)
    assert.deepEqual(extended.spec.dependencies, ['python=3.12', 'six', 'requests'])
    assert.deepEqual(extended.spec.channels, ['conda-forge'])
    assert.equal(extended.spec.sourcePackages?.[0]?.name, 'ggplot2')
    assert.equal(
      existsSync(join(state.project, '.phi', 'environments', 'python-x1', 'environment.yml')),
      true
    )
    assert.deepEqual(
      JSON.parse(readFileSync(join(state.project, '.phi', 'environments.json'), 'utf8')),
      {
        version: 1,
        overrides: { 'phi:python@1': 'project:python-x2' }
      }
    )
    assert.equal(readProjectSpec(state.project, 'python-x2').name, 'python-x2')
  } finally {
    remove(state.project)
  }
})

test('skill host and bindSession resolve through the project override', async () => {
  const project = mkdtempSync(join(tmpdir(), 'phi-env-override-'))
  const runtime = mkdtempSync(join(tmpdir(), 'phi-env-runtime-'))
  try {
    const platform = currentPlatform()
    const environmentsDir = join(runtime, 'environments')
    copyMinimal(join(environmentsDir, 'phi-python'))
    copyMinimal(join(project, '.phi', 'environments', 'python-x1'), 'python-x1')
    writeFileSync(
      join(project, '.phi', 'environments.json'),
      `${JSON.stringify({ version: 1, overrides: { 'phi:python@1': 'project:python-x1' } }, null, 2)}\n`
    )
    const skillDir = join(project, 'echo')
    mkdirSync(join(skillDir, 'scripts'), { recursive: true })
    writeFileSync(join(skillDir, 'scripts', 'echo.py'), 'print(1)\n')
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: echo
description: Echo script arguments as JSON.
phi:
  environment: phi:python@1
  toolPrefix: echo
  scripts:
    - name: echo
      description: Print the flags passed to the script as JSON.
      run: [python, ./scripts/echo.py]
      args:
        type: object
        additionalProperties: false
        properties:
          message:
            type: string
      approval: read
---
Echo script arguments as JSON.
`
    )
    const asked: string[] = []
    const builds = {
      list: () => [],
      cancel() {
        return undefined
      },
      start() {
        throw new Error('the override test must not build')
      }
    }
    const host = createSkillHost({
      runtimeRoot: runtime,
      environmentsDir,
      platform,
      listSkillDirs: async () => [skillDir],
      builds,
      confirmBuild: async (prompt) => {
        asked.push(prompt.ref)
        return false
      }
    })
    assert.equal(host.approvalFor('env_request', {}), undefined)
    await host.scriptTools({ cwd: project })
    const run = await host.run({
      requestId: 'run-1',
      cwd: project,
      skill: 'echo',
      script: 'echo.py',
      runtimeSessionId: 'runtime-1'
    })
    assert.ok(run && typeof run === 'object' && 'notReady' in run)
    if ('notReady' in run) assert.equal(run.notReady.ref, 'project:python-x1')
    const tool = await host.scriptTool({
      requestId: 'tool-1',
      cwd: project,
      tool: 'echo_echo',
      args: {},
      runtimeSessionId: 'runtime-1'
    })
    assert.equal(tool.ok, false)
    if (!tool.ok) assert.match(tool.error, /project:python-x1/)
    assert.deepEqual(asked, ['project:python-x1', 'project:python-x1'])

    const bound = await bindAgentSession(
      { runtimeSessionId: 'runtime-1', ref: 'phi:python@1', agent: 'Scanpy', cwd: project },
      {
        root: runtime,
        environmentsDir,
        platform,
        builds,
        confirmBuild: async (prompt) => {
          asked.push(prompt.ref)
          return false
        }
      }
    )
    assert.ok('notReady' in bound)
    if ('notReady' in bound) assert.equal(bound.notReady.ref, 'project:python-x1')

    const projectDescriptor = describeEnvironment('project:python-x1', {
      projectDir: project,
      platform
    })
    installReady(runtime, projectDescriptor, { python: shell(['echo from-project']) })
    const executed = await runSkillScript({
      root: runtime,
      projectDir: project,
      skill: skillStub(skillDir, 'echo', 'phi:python@1'),
      script: 'echo.py',
      environmentsDir,
      platform
    })
    assert.equal(executed.envId, envIdFor(projectDescriptor))
    assert.match(executed.stdout, /from-project/)
    assert.deepEqual(executed.warnings, [])

    writeFileSync(
      join(project, '.phi', 'environments.json'),
      `${JSON.stringify({ version: 1, overrides: { 'phi:python@1': 'project:gone-x1' } }, null, 2)}\n`
    )
    const phi = describeEnvironment('phi:python@1', { environmentsDir, platform })
    installReady(runtime, phi, { python: shell(['echo base']) })
    const ignored = await bindAgentSession(
      { runtimeSessionId: 'runtime-1', ref: 'phi:python@1', agent: 'Scanpy', cwd: project },
      { root: runtime, environmentsDir, platform }
    )
    assert.ok(!('notReady' in ignored))
    if (!('notReady' in ignored)) {
      assert.equal(ignored.ref, 'phi:python@1')
      assert.match(ignored.warnings?.[0] ?? '', /missing project environment 'project:gone-x1'/)
    }
  } finally {
    remove(project)
    remove(runtime)
  }
})

test('a bound env_request swaps the live bash variables and skill environment', async () => {
  const binding: EnvRequestBinding = {
    ref: 'phi:python@1',
    variables: { PATH: '/old/bin', HOME: '/old' }
  }
  let handler:
    ((event: { toolName: string; input: unknown }) => { input?: unknown } | undefined) | undefined
  createEnvironmentBindingExtension(binding)({
    on(event, fn) {
      if (event === 'tool_call') {
        handler = fn as NonNullable<typeof handler>
      }
    }
  } as never)
  if (!handler) throw new Error('binding extension did not register tool_call')
  const rewrite = handler

  const before = rewrite({ toolName: 'bash', input: { command: 'python -c "import six"' } })
  const beforeEnv = (before?.input as { env?: Record<string, string> } | undefined)?.env
  assert.equal(beforeEnv?.PATH, '/old/bin')

  const seen: string[] = []
  const requestHost = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'skills.run' || method === 'skills.scriptTool') {
      seen.push(String(params.sessionEnvironment))
      return { notReady: { ref: 'x', envId: 'e', message: 'not ready' } }
    }
    if (method === 'environments.request') {
      assert.ok(params.environment === 'phi:python@1' || params.environment === 'plugin:viz')
      return {
        ref: 'project:python-x1',
        envId: 'project-p0000000000-python-x1-abcdefabcdef',
        name: 'python-x1',
        added: ['six']
      }
    }
    if (method === 'environments.bindSession') {
      assert.equal(params.ref, 'project:python-x1')
      return {
        ref: 'project:python-x1',
        envId: 'project-p0000000000-python-x1-abcdefabcdef',
        variables: { PATH: '/new/bin', HOME: '/new' }
      }
    }
    throw new Error(`unexpected ${method}`)
  }
  const ctx = { sessionManager: { getCwd: () => '/proj' } }
  const skillRun = buildSkillRunTool(requestHost, {
    runtimeSessionId: 'runtime-1',
    environmentBinding: binding
  })
  const scriptTool = buildScriptTools(
    [
      {
        name: 'echo_echo',
        description: 'echo',
        parameters: { type: 'object', properties: {} },
        attachTo: ['Scanpy'],
        skill: 'echo',
        approval: 'read'
      }
    ],
    requestHost,
    { runtimeSessionId: 'runtime-1', environmentBinding: binding }
  )[0]
  assert.ok(scriptTool)
  await skillRun.execute(
    'call-1',
    { skill: 'echo', script: 'echo.py' },
    undefined,
    ctx as never,
    undefined
  )
  await scriptTool.execute('call-2', {}, undefined, ctx as never, undefined)

  const tool = buildEnvRequestTool(requestHost, {
    runtimeSessionId: 'runtime-1',
    binding,
    agent: 'Scanpy'
  })
  assert.equal(tool.approval, 'read')
  const result = await tool.execute(
    'call-3',
    { packages: ['six'], reason: 'need six' },
    undefined,
    ctx as never,
    undefined
  )
  const text = (result.content as Array<{ text: string }>).map((block) => block.text).join('')
  assert.match(text, /python-x1/)
  assert.equal(result.isError, undefined)
  assert.equal(binding.ref, 'project:python-x1')
  assert.equal(binding.variables.PATH, '/new/bin')

  await skillRun.execute(
    'call-4',
    { skill: 'echo', script: 'echo.py' },
    undefined,
    ctx as never,
    undefined
  )
  await scriptTool.execute('call-5', {}, undefined, ctx as never, undefined)
  assert.deepEqual(seen, ['phi:python@1', 'phi:python@1', 'project:python-x1', 'project:python-x1'])

  const after = rewrite({ toolName: 'bash', input: { command: 'python -c "import six"' } })
  const afterInput = after?.input as { command?: string; env?: Record<string, string> } | undefined
  assert.equal(afterInput?.env?.PATH, '/new/bin')
  assert.match(afterInput?.command ?? '', /import six/)

  const main = buildEnvRequestTool(requestHost, {
    runtimeSessionId: 'runtime-1',
    requireEnvironment: true
  })
  const missing = await main.execute(
    'call-6',
    { packages: ['six'], reason: 'need six' },
    undefined,
    ctx as never,
    undefined
  )
  assert.equal(missing.isError, true)
  const sent = await main.execute(
    'call-7',
    { packages: ['six'], reason: 'need six', environment: 'plugin:viz' },
    undefined,
    ctx as never,
    undefined
  )
  assert.match(
    (sent.content as Array<{ text: string }>).map((block) => block.text).join(''),
    /python-x1/
  )
})

function integrationSkip(): string | false {
  if (process.env.PHI_RUNTIME_INTEGRATION !== '1') {
    return 'network integration: set PHI_RUNTIME_INTEGRATION=1 (npm run test:runtime)'
  }
  if (process.env.PHI_OFFLINE === '1') return 'PHI_OFFLINE=1'
  try {
    getMicromambaPath()
    return false
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

test(
  'env_request solves and builds six without changing the base environment',
  { skip: integrationSkip(), timeout: 900_000 },
  async () => {
    const platform = findPlatform()
    if (!platform) throw new Error(`unsupported platform: ${process.platform}-${process.arch}`)
    const root = createTestRuntimeRoot('env-request-six')
    const project = mkdtempSync(join(tmpdir(), 'phi-env-request-project-'))
    try {
      const environmentsDir = join(root, 'environments')
      copyMinimal(join(environmentsDir, 'phi-python'))
      const base = describeEnvironment('phi:python@1', { environmentsDir, platform })
      const baseHandle = await buildEnvironment(root, base)
      const baseMissing = await runInEnvironment(baseHandle, ['python', '-c', 'import six'], {
        cwd: project
      })
      assert.notEqual(baseMissing.exitCode, 0)

      const result = await requestProjectEnvironment(
        {
          runtimeSessionId: 'runtime-1',
          cwd: project,
          packages: ['six'],
          reason: 'need six',
          environment: 'phi:python@1'
        },
        {
          root,
          platform,
          environmentsDir,
          confirm: async () => true,
          builds: createEnvironmentBuilds({ root })
        }
      )
      assert.ok(!('error' in result) && !('declined' in result), JSON.stringify(result))
      if ('error' in result || 'declined' in result) return
      assert.equal(result.ref, 'project:python-x1')
      assert.deepEqual(result.added, ['six'])
      const spec = parseEnvironmentSpec(
        readFileSync(join(project, '.phi', 'environments', 'python-x1', 'environment.yml'), 'utf8')
      )
      assert.equal(spec.ok, true)
      if (!spec.ok) return
      assert.deepEqual(spec.spec.dependencies, ['python=3.12', 'six'])
      const lock = readFileSync(
        join(project, '.phi', 'environments', 'python-x1', 'locks', `${platform}.txt`),
        'utf8'
      )
      assert.match(lock, /# download-bytes: \d+/)
      assert.equal(lock.includes('# baseline:'), false)

      const created = describeEnvironment(result.ref, { projectDir: project, platform })
      const handle = readyEnvironment(root, created)
      assert.equal(handle.envId, result.envId)
      const imported = await runInEnvironment(handle, ['python', '-c', 'import six'], {
        cwd: project
      })
      assert.equal(imported.exitCode, 0, imported.stderr)

      const baseStillMissing = await runInEnvironment(baseHandle, ['python', '-c', 'import six'], {
        cwd: project
      })
      assert.notEqual(baseStillMissing.exitCode, 0)
    } finally {
      removeTree(root)
      remove(project)
    }
  }
)
