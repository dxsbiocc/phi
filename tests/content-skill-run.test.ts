import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  EnvironmentNotReadyError,
  buildEnvironment,
  describeEnvironment,
  readyEnvironment,
  runScriptTool,
  runSkillScript,
  scriptToolApproval,
  type RunSkillScriptInput,
  type ScriptToolResult,
  scriptToolsOf,
  validateSkill,
  type ScriptTool,
  type ValidatedSkill
} from '../src/main/agent/content'
import { currentPlatform, removeTree, type PhiPlatform } from '../src/main/agent/envs'
import { getMicromambaPath } from '../src/main/agent/envs/paths'
import {
  argvShell,
  copyMinimal,
  envIdFor,
  installReady,
  shell,
  shQuote,
  skillStub
} from './helpers/fakeEnvironment'
import { createTestRuntimeRoot } from './helpers/testRuntimeRoot'

const SKILL_MD = `---
name: echo
description: Echo script arguments as JSON.
phi:
  environment: ./environment.yml
  toolPrefix: echo
  scripts:
    - name: echo
      description: Print the flags passed to the script as JSON.
      run: [python, ./scripts/echo.py]
      args:
        type: object
        additionalProperties: false
        required: [message]
        properties:
          message:
            type: string
      approval: read
---
Echo.
`

interface Runtime {
  root: string
  projectDir: string
  skillDir: string
  environmentsDir: string
  platform: PhiPlatform
  skill: ValidatedSkill
  bare: ValidatedSkill
  declaredPython: ValidatedSkill
  marker: string
  skillEnvId: string
  pythonEnvId: string
  rEnvId: string
}

function integrationSkipReason(): string | false {
  if (process.env.PHI_RUNTIME_INTEGRATION !== '1') {
    return 'network integration: set PHI_RUNTIME_INTEGRATION=1 (npm run test:runtime)'
  }
  if (process.env.PHI_OFFLINE === '1') return 'PHI_OFFLINE=1; integration tests skipped'
  try {
    getMicromambaPath()
    return false
  } catch (error) {
    const message = error instanceof Error ? error.message : 'bundled micromamba is unavailable'
    return `${message}; integration tests skipped`
  }
}

const integrationSkip = integrationSkipReason()

async function withTemp(name: string, body: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `phi-skill-run-${name}-`))
  try {
    await body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeScript(skillDir: string, name: string): string {
  const file = join(skillDir, 'scripts', name)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `print(${JSON.stringify(name)})\n`)
  return file
}

function makeTool(overrides: Partial<ScriptTool> = {}): ScriptTool {
  return {
    name: 'echo_echo',
    description: 'Echo arguments',
    run: ['python'],
    args: { type: 'object', additionalProperties: false, properties: {} },
    approval: 'read',
    attachTo: ['main'],
    ...overrides
  }
}

function messageOf(error: unknown): string {
  assert.ok(error instanceof Error)
  return error.message
}

async function withRuntime(body: (runtime: Runtime) => Promise<void>): Promise<void> {
  await withTemp('run', async (root) => {
    const platform = currentPlatform()
    const environmentsDir = join(root, 'environments')
    const skillDir = join(root, 'echo')
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    copyMinimal(skillDir)
    copyMinimal(join(environmentsDir, 'phi-python'))
    copyMinimal(join(environmentsDir, 'phi-r'), 'rmin')
    mkdirSync(join(skillDir, 'scripts'), { recursive: true })
    const skill = skillStub(skillDir, 'echo', './environment.yml')
    const skillDescriptor = describeEnvironment('./environment.yml', { skill, platform })
    const pythonDescriptor = describeEnvironment('phi:python@1', { environmentsDir, platform })
    const rDescriptor = describeEnvironment('phi:r@1', { environmentsDir, platform })
    const marker = join(root, 'ran')
    const printer = join(root, 'print-argv.cjs')
    writeFileSync(
      printer,
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n")\n'
    )
    const nodePath = process.execPath
    const binaries: Record<string, string> = {
      python: argvShell(nodePath, printer, marker),
      Rscript: argvShell(nodePath, printer, marker),
      bash: argvShell(nodePath, printer, marker),
      node: argvShell(nodePath, printer, marker),
      perl: argvShell(nodePath, printer, marker),
      sleeper: shell(['exec sleep 30']),
      'fail-error': shell([`printf '%s\\n' '{"error":"disk full"}'`, 'exit 3']),
      'fail-stderr': shell([
        `printf '%s\\n' '{"ok":true}'`,
        `exec ${shQuote(nodePath)} -e 'process.stderr.write("y".repeat(2500)); process.exit(4)'`
      ]),
      'fail-code': shell(['exit 5']),
      'bad-json': shell([`printf '%s\\n' 'not-json'`, 'exit 0']),
      'schema-bad': shell([`printf '%s\\n' '{"value":"nope"}'`, 'exit 0']),
      'schema-ok': shell([`printf '%s\\n' '{"value":1}'`, 'exit 0'])
    }
    installReady(root, skillDescriptor, binaries)
    installReady(root, pythonDescriptor, binaries)
    installReady(root, rDescriptor, binaries)
    await body({
      root,
      projectDir,
      skillDir,
      environmentsDir,
      platform,
      skill,
      bare: skillStub(skillDir, 'echo'),
      declaredPython: skillStub(skillDir, 'echo', 'phi:python@1'),
      marker,
      skillEnvId: envIdFor(skillDescriptor),
      pythonEnvId: envIdFor(pythonDescriptor),
      rEnvId: envIdFor(rDescriptor)
    })
  })
}

function skillRun(
  runtime: Runtime,
  script: string,
  extra: { cwd?: string; skill?: ValidatedSkill; sessionEnvironment?: string } = {}
): RunSkillScriptInput {
  return {
    root: runtime.root,
    projectDir: runtime.projectDir,
    skill: extra.skill ?? runtime.skill,
    script,
    environmentsDir: runtime.environmentsDir,
    platform: runtime.platform,
    ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
    ...(extra.sessionEnvironment === undefined
      ? {}
      : { sessionEnvironment: extra.sessionEnvironment })
  }
}

test('describeEnvironment resolves phi, skill-local, plugin, and project refs', async () => {
  await withTemp('describe', (root) => {
    const platform = currentPlatform()
    const environmentsDir = join(root, 'environments')
    copyMinimal(join(environmentsDir, 'phi-python'))
    const skillDir = join(root, 'echo')
    copyMinimal(skillDir)
    const skill = skillStub(skillDir, 'echo', './environment.yml')

    const phi = describeEnvironment('phi:python@1', { environmentsDir, platform })
    assert.equal(phi.ref, 'phi:python@1')
    assert.equal(phi.scope, 'phi')
    assert.equal(phi.kind, 'base')
    assert.equal(phi.owner, undefined)
    assert.equal(phi.spec.name, 'minimal')
    assert.equal(phi.platform, platform)
    assert.match(phi.lockText, /@EXPLICIT/)

    const local = describeEnvironment('./environment.yml', { skill, environmentsDir, platform })
    assert.equal(local.ref, './environment.yml')
    assert.equal(local.scope, 'skill')
    assert.equal(local.kind, 'package')
    assert.equal(local.owner, 'echo')
    assert.equal(local.spec.name, 'minimal')
    assert.match(local.lockText, /@EXPLICIT/)

    assert.throws(
      () => describeEnvironment('plugin:viz', { platform }),
      /plugin environments are not supported yet \(implementation plan step 6\)/
    )
    assert.throws(
      () => describeEnvironment('project:alpha', { platform }),
      /project environments are not supported yet \(implementation plan step 4\.9\)/
    )
    assert.throws(
      () => describeEnvironment('phi:python@2', { environmentsDir, platform }),
      /environment phi:python@2 is not available/
    )
    assert.throws(
      () => describeEnvironment('./environment.yml', { platform }),
      /\.\/environment\.yml requires a skill/
    )

    const missingLock = join(root, 'missing-lock')
    mkdirSync(missingLock, { recursive: true })
    writeFileSync(
      join(missingLock, 'environment.yml'),
      readFileSync(join(skillDir, 'environment.yml'))
    )
    assert.throws(
      () =>
        describeEnvironment('./environment.yml', {
          skill: skillStub(missingLock, 'echo', './environment.yml'),
          platform
        }),
      (error: unknown) => {
        const message = messageOf(error)
        assert.match(message, /environment lock is missing:/)
        assert.ok(message.includes(join(missingLock, 'locks', `${platform}.txt`)))
        return true
      }
    )

    const badSpec = join(root, 'bad-spec')
    mkdirSync(join(badSpec, 'locks'), { recursive: true })
    writeFileSync(join(badSpec, 'environment.yml'), '[]\n')
    writeFileSync(
      join(badSpec, 'locks', `${platform}.txt`),
      readFileSync(join(skillDir, 'locks', `${platform}.txt`))
    )
    assert.throws(
      () =>
        describeEnvironment('./environment.yml', {
          skill: skillStub(badSpec, 'echo', './environment.yml'),
          platform
        }),
      (error: unknown) => {
        const message = messageOf(error)
        assert.match(message, /environment spec .* is invalid:/)
        assert.ok(message.includes(join(badSpec, 'environment.yml')))
        return true
      }
    )

    const badLock = join(root, 'bad-lock')
    copyMinimal(badLock)
    writeFileSync(join(badLock, 'locks', `${platform}.txt`), 'not a lock\n')
    assert.throws(
      () =>
        describeEnvironment('./environment.yml', {
          skill: skillStub(badLock, 'echo', './environment.yml'),
          platform
        }),
      (error: unknown) => {
        const message = messageOf(error)
        assert.match(message, /environment lock .* is invalid:/)
        assert.ok(message.includes(join(badLock, 'locks', `${platform}.txt`)))
        return true
      }
    )
  })
})

test('readyEnvironment returns a handle only when the environment is ready', async () => {
  await withTemp('ready', (root) => {
    const platform = currentPlatform()
    const skillDir = join(root, 'echo')
    copyMinimal(skillDir)
    const skill = skillStub(skillDir, 'echo', './environment.yml')
    const descriptor = describeEnvironment('./environment.yml', { skill, platform })
    const envId = envIdFor(descriptor)

    assert.throws(
      () => readyEnvironment(root, descriptor),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentNotReadyError)
        assert.equal(error.message, 'environment ./environment.yml is not ready')
        assert.equal(error.ref, './environment.yml')
        assert.equal(error.envId, envId)
        assert.equal(error.descriptor, descriptor)
        return true
      }
    )

    installReady(root, descriptor, {})
    const handle = readyEnvironment(root, descriptor)
    assert.equal(handle.envId, envId)
    assert.equal(handle.prefix, join(root, 'envs', envId))
    assert.equal(handle.metadata.status, 'ready')

    const metadata = JSON.parse(readFileSync(join(handle.prefix, '.phi', 'env.json'), 'utf8')) as {
      status: string
    }
    metadata.status = 'failed'
    writeFileSync(join(handle.prefix, '.phi', 'env.json'), JSON.stringify(metadata))
    assert.throws(
      () => readyEnvironment(root, descriptor),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentNotReadyError)
        assert.equal(error.message, 'environment ./environment.yml is not ready')
        return true
      }
    )
  })
})

test('runSkillScript maps interpreters and passes argv through', async () => {
  await withRuntime(async (runtime) => {
    const cases = [
      ['run.py', 'python'],
      ['run.R', 'Rscript'],
      ['lower.r', 'Rscript'],
      ['run.sh', 'bash'],
      ['run.js', 'node'],
      ['run.mjs', 'node'],
      ['run.pl', 'perl']
    ] as const
    for (const [name, interpreter] of cases) {
      const file = writeScript(runtime.skillDir, name)
      const result = await runSkillScript({
        ...skillRun(runtime, name),
        args: ['--limit', '2', 'a b']
      })
      const parsed = JSON.parse(result.stdout) as { argv: string[] }
      assert.deepEqual(parsed.argv, [realpathSync(file), '--limit', '2', 'a b'], name)
      assert.equal(
        result.resolvedCommand,
        join(runtime.root, 'envs', runtime.skillEnvId, 'bin', interpreter),
        name
      )
      assert.equal(result.exitCode, 0, name)
      assert.equal(result.terminated, undefined, name)
      assert.deepEqual(result.truncated, { stdout: false, stderr: false }, name)
      assert.equal(result.envId, runtime.skillEnvId, name)
      assert.deepEqual(result.warnings, [], name)
      assert.ok(result.durationMs >= 0, name)
    }
  })
})

test('runSkillScript rejects script paths that leave scripts/', async () => {
  await withRuntime(async (runtime) => {
    writeFileSync(join(runtime.skillDir, 'secret.py'), 'print(1)\n')
    const outside = join(runtime.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.py'), 'print(1)\n')
    symlinkSync(outside, join(runtime.skillDir, 'scripts', 'escape'))
    writeScript(runtime.skillDir, 'notes.txt')

    await assert.rejects(
      () => runSkillScript(skillRun(runtime, '../secret.py')),
      /must stay inside scripts/
    )
    await assert.rejects(
      () => runSkillScript(skillRun(runtime, join(outside, 'secret.py'))),
      /must be relative to scripts/
    )
    await assert.rejects(
      () => runSkillScript(skillRun(runtime, 'escape/secret.py')),
      /resolves outside scripts/
    )
    await assert.rejects(() => runSkillScript(skillRun(runtime, 'missing.py')), /does not exist/)
    await assert.rejects(
      () => runSkillScript(skillRun(runtime, 'notes.txt')),
      /unsupported script extension/
    )
    assert.equal(existsSync(runtime.marker), false)
  })
})

test('runSkillScript keeps cwd inside the project', async () => {
  await withRuntime(async (runtime) => {
    writeScript(runtime.skillDir, 'pwd.sh')
    const nested = join(runtime.projectDir, 'nested')
    mkdirSync(nested)

    const atRoot = await runSkillScript(skillRun(runtime, 'pwd.sh'))
    assert.equal(JSON.parse(atRoot.stdout).cwd, realpathSync(runtime.projectDir))

    const atNested = await runSkillScript(skillRun(runtime, 'pwd.sh', { cwd: 'nested' }))
    assert.equal(JSON.parse(atNested.stdout).cwd, realpathSync(nested))

    await assert.rejects(
      () => runSkillScript(skillRun(runtime, 'pwd.sh', { cwd: '..' })),
      /must stay inside the project/
    )
    await assert.rejects(
      () => runSkillScript(skillRun(runtime, 'pwd.sh', { cwd: '/tmp' })),
      /must be project-relative/
    )

    const elsewhere = join(runtime.root, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(runtime.projectDir, 'linked'))
    await assert.rejects(
      () => runSkillScript(skillRun(runtime, 'pwd.sh', { cwd: 'linked' })),
      /must stay inside the project/
    )
  })
})

test('runSkillScript resolves skill, then session, then phi:python@1', async () => {
  await withRuntime(async (runtime) => {
    writeScript(runtime.skillDir, 'run.py')
    const skillFirst = await runSkillScript(
      skillRun(runtime, 'run.py', { sessionEnvironment: 'phi:r@1' })
    )
    assert.equal(skillFirst.envId, runtime.skillEnvId)
    assert.deepEqual(skillFirst.warnings, [])

    const session = await runSkillScript(
      skillRun(runtime, 'run.py', { skill: runtime.bare, sessionEnvironment: 'phi:r@1' })
    )
    assert.equal(session.envId, runtime.rEnvId)
    assert.deepEqual(session.warnings, [])

    const fallback = await runSkillScript(skillRun(runtime, 'run.py', { skill: runtime.bare }))
    assert.equal(fallback.envId, runtime.pythonEnvId)
    assert.deepEqual(fallback.warnings, ['skill echo declares no environment'])

    const declared = await runSkillScript(
      skillRun(runtime, 'run.py', { skill: runtime.declaredPython })
    )
    assert.equal(declared.envId, runtime.pythonEnvId)
    assert.deepEqual(declared.warnings, [])
  })
})

test('runSkillScript propagates EnvironmentNotReadyError', async () => {
  await withTemp('skill-not-ready', async (root) => {
    const platform = currentPlatform()
    const skillDir = join(root, 'echo')
    const projectDir = join(root, 'project')
    mkdirSync(projectDir)
    copyMinimal(skillDir)
    writeScript(skillDir, 'run.py')
    const skill = skillStub(skillDir, 'echo', './environment.yml')
    await assert.rejects(
      () => runSkillScript({ root, projectDir, skill, script: 'run.py', platform }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentNotReadyError)
        assert.equal(error.message, 'environment ./environment.yml is not ready')
        return true
      }
    )
  })
})

test('runScriptTool reports an environment that is not ready', async () => {
  await withTemp('tool-not-ready', async (root) => {
    const platform = currentPlatform()
    const environmentsDir = join(root, 'environments')
    const projectDir = join(root, 'project')
    mkdirSync(projectDir)
    copyMinimal(join(environmentsDir, 'phi-python'))
    const result = await runScriptTool({
      root,
      projectDir,
      skill: skillStub(join(root, 'echo'), 'echo'),
      tool: makeTool(),
      args: {},
      environmentsDir,
      platform
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error, 'environment phi:python@1 is not ready')
      assert.deepEqual(result.warnings, ['skill echo declares no environment'])
      assert.equal(typeof result.envId, 'string')
    }
  })
})

test('runScriptTool returns an error for an unsupported environment reference', async () => {
  await withTemp('tool-plugin-env', async (root) => {
    const projectDir = join(root, 'project')
    mkdirSync(projectDir)
    const result = await runScriptTool({
      root,
      projectDir,
      skill: skillStub(join(root, 'echo'), 'echo', 'plugin:viz'),
      tool: makeTool(),
      args: {},
      platform: currentPlatform()
    })
    assert.deepEqual(result, {
      ok: false,
      error: 'plugin environments are not supported yet (implementation plan step 6)',
      warnings: []
    })
  })
})

test('runScriptTool rejects invalid arguments and paths before running', async () => {
  await withRuntime(async (runtime) => {
    const script = writeScript(runtime.skillDir, 'echo.py')
    const tool = makeTool({
      run: ['python', script],
      args: {
        type: 'object',
        additionalProperties: false,
        required: ['zeta', 'src'],
        properties: {
          zeta: { type: 'string' },
          src: { type: 'string', format: 'input-path' },
          dest: { type: 'string', format: 'project-path' }
        }
      }
    })
    const common = {
      root: runtime.root,
      projectDir: runtime.projectDir,
      skill: runtime.skill,
      tool,
      environmentsDir: runtime.environmentsDir,
      platform: runtime.platform
    }

    const invalid = await runScriptTool({ ...common, args: {} })
    assert.equal(invalid.ok, false)
    if (!invalid.ok) assert.match(invalid.error, /zeta/)
    assert.equal(existsSync(runtime.marker), false)

    const outsideFile = join(runtime.root, 'outside.txt')
    writeFileSync(outsideFile, 'x')
    const outside = await runScriptTool({
      ...common,
      args: { zeta: 'hello', src: outsideFile }
    })
    assert.equal(outside.ok, false)
    if (!outside.ok) assert.match(outside.error, /outside the project/)
    assert.equal(existsSync(runtime.marker), false)

    const missing = await runScriptTool({
      ...common,
      args: { zeta: 'hello', src: 'missing.txt' }
    })
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.match(missing.error, /does not exist/)
    assert.equal(existsSync(runtime.marker), false)

    const parent = await runScriptTool({
      ...common,
      tool: makeTool({
        run: ['python', script],
        args: {
          type: 'object',
          additionalProperties: false,
          required: ['dest'],
          properties: { dest: { type: 'string', format: 'project-path' } }
        }
      }),
      args: { dest: 'nope/out.txt' }
    })
    assert.equal(parent.ok, false)
    if (!parent.ok) assert.match(parent.error, /parent does not exist/)
    assert.equal(existsSync(runtime.marker), false)
  })
})

test('runScriptTool maps flags in property order and rewrites paths', async () => {
  await withRuntime(async (runtime) => {
    const script = writeScript(runtime.skillDir, 'echo.py')
    writeFileSync(join(runtime.projectDir, 'in.txt'), 'in')
    writeFileSync(join(runtime.projectDir, 'a.txt'), 'a')
    writeFileSync(join(runtime.projectDir, 'b.txt'), 'b')
    mkdirSync(join(runtime.projectDir, 'out'))
    const result = await runScriptTool({
      root: runtime.root,
      projectDir: runtime.projectDir,
      skill: runtime.skill,
      tool: makeTool({
        run: ['python', script],
        args: {
          type: 'object',
          additionalProperties: false,
          required: ['zeta', 'count', 'ratio', 'verbose', 'quiet', 'tags', 'src', 'files', 'dest'],
          properties: {
            zeta: { type: 'string' },
            count: { type: 'integer' },
            ratio: { type: 'number' },
            verbose: { type: 'boolean' },
            quiet: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' },
            src: { type: 'string', format: 'input-path' },
            files: { type: 'array', items: { type: 'string', format: 'input-path' } },
            dest: { type: 'string', format: 'project-path' }
          }
        }
      }),
      args: {
        zeta: 'hello',
        count: 3,
        ratio: 1.5,
        verbose: true,
        quiet: false,
        tags: ['a', 'b'],
        src: 'in.txt',
        files: ['a.txt', 'b.txt'],
        dest: 'out/file.txt'
      },
      environmentsDir: runtime.environmentsDir,
      platform: runtime.platform
    })
    assert.equal(result.ok, true, result.ok ? '' : result.error)
    if (!result.ok) return
    assert.deepEqual(result.output.argv, [
      script,
      '--zeta',
      'hello',
      '--count',
      '3',
      '--ratio',
      '1.5',
      '--verbose',
      '--tags',
      'a',
      '--tags',
      'b',
      '--src',
      realpathSync(join(runtime.projectDir, 'in.txt')),
      '--files',
      realpathSync(join(runtime.projectDir, 'a.txt')),
      '--files',
      realpathSync(join(runtime.projectDir, 'b.txt')),
      '--dest',
      join(realpathSync(runtime.projectDir), 'out', 'file.txt')
    ])
  })
})

test('runScriptTool parses JSON output and reports failures', async () => {
  await withRuntime(async (runtime) => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['value'],
      properties: { value: { type: 'number' } }
    }
    const run = (
      command: string,
      outputSchema?: Record<string, unknown>
    ): Promise<ScriptToolResult> =>
      runScriptTool({
        root: runtime.root,
        projectDir: runtime.projectDir,
        skill: runtime.skill,
        tool: makeTool({
          run: [command],
          ...(outputSchema ? { outputSchema } : {})
        }),
        args: {},
        environmentsDir: runtime.environmentsDir,
        platform: runtime.platform
      })

    const badJson = await run('bad-json')
    assert.equal(badJson.ok, false)
    if (!badJson.ok) assert.equal(badJson.error, 'stdout is not a JSON object')

    const violation = await run('schema-bad', schema)
    assert.equal(violation.ok, false)
    if (!violation.ok) assert.match(violation.error, /output does not match the schema/)

    const ok = await run('schema-ok', schema)
    assert.equal(ok.ok, true, ok.ok ? '' : ok.error)
    if (ok.ok) assert.deepEqual(ok.output, { value: 1 })

    const reported = await run('fail-error')
    assert.equal(reported.ok, false)
    if (!reported.ok) assert.equal(reported.error, 'disk full')

    const stderr = await run('fail-stderr')
    assert.equal(stderr.ok, false)
    if (!stderr.ok) assert.equal(stderr.error, 'y'.repeat(2000))

    const code = await run('fail-code')
    assert.equal(code.ok, false)
    if (!code.ok) assert.equal(code.error, 'exit code 5')
  })
})

test('runScriptTool reports timeout and abort', { timeout: 20_000 }, async () => {
  await withRuntime(async (runtime) => {
    const timedOut = await runScriptTool({
      root: runtime.root,
      projectDir: runtime.projectDir,
      skill: runtime.skill,
      tool: makeTool({ run: ['sleeper'], timeoutSeconds: 1 }),
      args: {},
      environmentsDir: runtime.environmentsDir,
      platform: runtime.platform
    })
    assert.equal(timedOut.ok, false)
    if (!timedOut.ok) assert.equal(timedOut.error, 'timed out')

    const controller = new AbortController()
    const pending = runScriptTool({
      root: runtime.root,
      projectDir: runtime.projectDir,
      skill: runtime.skill,
      tool: makeTool({ run: ['sleeper'], timeoutSeconds: 30 }),
      args: {},
      signal: controller.signal,
      environmentsDir: runtime.environmentsDir,
      platform: runtime.platform
    })
    controller.abort()
    const aborted = await pending
    assert.equal(aborted.ok, false)
    if (!aborted.ok) assert.equal(aborted.error, 'aborted')
  })
})

test('scriptToolApproval follows declared approval and project-path arguments', () => {
  const input = { type: 'string', format: 'input-path' }
  const output = { type: 'string', format: 'project-path' }
  const inputs = { type: 'array', items: { type: 'string', format: 'input-path' } }
  const outputs = { type: 'array', items: { type: 'string', format: 'project-path' } }
  const cases: Array<{
    name: string
    approval: 'read' | 'write'
    properties: Record<string, unknown>
    args: unknown
    expected: 'read' | 'write'
  }> = [
    { name: 'write tool', approval: 'write', properties: {}, args: {}, expected: 'write' },
    {
      name: 'write tool with an input-path',
      approval: 'write',
      properties: { src: input },
      args: { src: 'a' },
      expected: 'write'
    },
    {
      name: 'read tool without paths',
      approval: 'read',
      properties: { q: { type: 'string' } },
      args: { q: 'a' },
      expected: 'read'
    },
    {
      name: 'read tool with an input-path',
      approval: 'read',
      properties: { src: input },
      args: { src: 'a' },
      expected: 'read'
    },
    {
      name: 'read tool with an input-path array',
      approval: 'read',
      properties: { srcs: inputs },
      args: { srcs: ['a'] },
      expected: 'read'
    },
    {
      name: 'read tool that declares a project-path, even when omitted',
      approval: 'read',
      properties: { src: input, dest: output },
      args: { src: 'a' },
      expected: 'write'
    },
    {
      name: 'read tool called with a project-path',
      approval: 'read',
      properties: { dest: output },
      args: { dest: 'b' },
      expected: 'write'
    },
    {
      name: 'read tool that declares a project-path array',
      approval: 'read',
      properties: { dests: outputs },
      args: {},
      expected: 'write'
    }
  ]
  for (const entry of cases) {
    const tool = makeTool({
      approval: entry.approval,
      args: { type: 'object', additionalProperties: false, properties: entry.properties }
    })
    assert.equal(scriptToolApproval(tool, entry.args), entry.expected, entry.name)
  }
})

test(
  'integration: buildEnvironment then runScriptTool and runSkillScript',
  { timeout: 600_000, skip: integrationSkip },
  async () => {
    const root = createTestRuntimeRoot('skill-run')
    try {
      const runtimeRoot = realpathSync(root)
      const platform = currentPlatform()
      const skillDir = join(runtimeRoot, 'echo')
      const projectDir = join(runtimeRoot, 'project')
      mkdirSync(projectDir, { recursive: true })
      copyMinimal(skillDir)
      writeScript(skillDir, 'echo.py')
      writeFileSync(
        join(skillDir, 'scripts', 'echo.py'),
        'import json\nimport sys\nprint(json.dumps({"got": sys.argv[1:]}))\n'
      )
      writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD)
      const validated = validateSkill(skillDir)
      assert.equal(validated.ok, true, JSON.stringify(validated.errors))
      assert.ok(validated.skill)
      const skill = validated.skill
      const tools = scriptToolsOf(skill, { prefix: 'echo' })
      const tool = tools[0]
      assert.ok(tool)
      const descriptor = describeEnvironment('./environment.yml', { skill, platform })
      await buildEnvironment(runtimeRoot, descriptor)
      const ran = await runScriptTool({
        root: runtimeRoot,
        projectDir,
        skill,
        tool,
        args: { message: 'hi' },
        platform
      })
      assert.equal(ran.ok, true, ran.ok ? '' : ran.error)
      if (ran.ok) {
        assert.deepEqual(ran.output.got, ['--message', 'hi'])
        assert.equal(ran.envId, envIdFor(descriptor))
        assert.deepEqual(ran.warnings, [])
      }
      const script = await runSkillScript({
        root: runtimeRoot,
        projectDir,
        skill,
        script: 'echo.py',
        args: ['a', 'b'],
        platform
      })
      assert.equal(script.exitCode, 0, script.stderr)
      assert.deepEqual(JSON.parse(script.stdout), { got: ['a', 'b'] })
      assert.equal(script.envId, envIdFor(descriptor))
      assert.deepEqual(script.warnings, [])
    } finally {
      removeTree(root)
    }
  }
)
