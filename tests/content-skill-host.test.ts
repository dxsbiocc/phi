import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { describeEnvironment, validateSkill } from '../src/main/agent/content'
import type { EnvironmentBuilds } from '../src/main/agent/content/environment-builds'
import {
  createSkillHost,
  type ConfirmBuildRequest,
  type SkillHost
} from '../src/main/agent/content/skill-host'
import { currentPlatform, type EnvHandle, type PhiPlatform } from '../src/main/agent/envs'
import type { EnvironmentBuild } from '../src/shared/environmentBuildTypes'
import {
  argvShell,
  copyMinimal,
  envIdFor,
  installReady,
  shell,
  shQuote
} from './helpers/fakeEnvironment'

function skillMarkdown(options: {
  name: string
  description: string
  toolPrefix: string
  attachTo?: string[]
  scriptName: string
  scriptDescription: string
  scriptFile: string
  approval: 'read' | 'write'
  args: string
}): string {
  const attach = options.attachTo ? `\n  attachTo: [${options.attachTo.join(', ')}]` : ''
  return `---
name: ${options.name}
description: ${options.description}
phi:
  environment: phi:python@1
  toolPrefix: ${options.toolPrefix}${attach}
  scripts:
    - name: ${options.scriptName}
      description: ${options.scriptDescription}
      run: [python, ./scripts/${options.scriptFile}]
      args:
${options.args}
      approval: ${options.approval}
---
${options.description}
`
}

const MESSAGE_ARGS = `        type: object
        additionalProperties: false
        required: [message]
        properties:
          message:
            type: string`

const DEST_ARGS = `        type: object
        additionalProperties: false
        properties:
          dest:
            type: string
            format: project-path`

interface Fixture {
  root: string
  projectDir: string
  environmentsDir: string
  dirs: string[]
  host: SkillHost
}

function writeSkill(root: string, name: string, markdown: string, scriptFile: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), markdown)
  if (scriptFile) writeFileSync(join(dir, 'scripts', scriptFile), 'print(1)\n')
  return dir
}

async function withFixture(
  body: (fixture: Fixture) => Promise<void>,
  options: {
    ready?: boolean
    builds?: (ctx: {
      root: string
      environmentsDir: string
      platform: PhiPlatform
    }) => EnvironmentBuilds
    confirmBuild?: (request: ConfirmBuildRequest) => Promise<boolean>
  } = {}
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-skill-host-'))
  try {
    const projectDir = join(root, 'project')
    const environmentsDir = join(root, 'environments')
    mkdirSync(projectDir, { recursive: true })
    copyMinimal(join(environmentsDir, 'phi-python'))
    const platform = currentPlatform()
    const dirs = [
      writeSkill(
        root,
        'echo',
        skillMarkdown({
          name: 'echo',
          description: 'Echo script arguments as JSON.',
          toolPrefix: 'echo',
          attachTo: ['main', 'Database'],
          scriptName: 'echo',
          scriptDescription: 'Print the flags passed to the script as JSON.',
          scriptFile: 'echo.py',
          approval: 'read',
          args: MESSAGE_ARGS
        }),
        'echo.py'
      ),
      writeSkill(
        root,
        'writer',
        skillMarkdown({
          name: 'writer',
          description: 'Write a table into the project.',
          toolPrefix: 'writer',
          scriptName: 'save',
          scriptDescription: 'Save a named table.',
          scriptFile: 'save.py',
          approval: 'write',
          args: MESSAGE_ARGS
        }),
        'save.py'
      ),
      writeSkill(
        root,
        'paths',
        skillMarkdown({
          name: 'paths',
          description: 'Copy a file inside the project.',
          toolPrefix: 'paths',
          scriptName: 'copy',
          scriptDescription: 'Copy a file to a project path.',
          scriptFile: 'copy.py',
          approval: 'read',
          args: DEST_ARGS
        }),
        'copy.py'
      ),
      writeSkill(
        root,
        'again',
        skillMarkdown({
          name: 'again',
          description: 'Duplicate of the echo tool.',
          toolPrefix: 'echo',
          scriptName: 'echo',
          scriptDescription: 'Second echo tool, ignored.',
          scriptFile: 'echo.py',
          approval: 'read',
          args: MESSAGE_ARGS
        }),
        'echo.py'
      ),
      writeSkill(root, 'broken', 'this is not a skill\n', '')
    ]
    if (options.ready) {
      const skill = validateSkill(dirs[0])
      assert.equal(skill.ok, true, JSON.stringify(skill.errors))
      assert.ok(skill.skill)
      const descriptor = describeEnvironment('phi:python@1', {
        skill: skill.skill,
        environmentsDir,
        platform
      })
      const marker = join(root, 'ran')
      const printer = join(root, 'print-argv.cjs')
      writeFileSync(
        printer,
        'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n")\n'
      )
      installReady(root, descriptor, {
        python: argvShell(process.execPath, printer, marker),
        bash: shell(['exec sleep 30'])
      })
    }
    const host = createSkillHost({
      runtimeRoot: root,
      environmentsDir,
      platform,
      listSkillDirs: async () => dirs,
      ...(options.builds ? { builds: options.builds({ root, environmentsDir, platform }) } : {}),
      ...(options.confirmBuild ? { confirmBuild: options.confirmBuild } : {})
    })
    await body({ root, projectDir, environmentsDir, dirs, host })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function isNotReady(
  result: unknown
): result is { notReady: { ref: string; envId: string; message: string } } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'notReady' in result &&
    typeof (result as { notReady?: { message?: unknown } }).notReady?.message === 'string'
  )
}

test('script tools list valid skills, skip invalid ones, and keep the first duplicate', async () => {
  await withFixture(async ({ host }) => {
    assert.equal(host.approvalFor('skill_run', { skill: 'echo', script: 'echo.py' }), 'exec')
    assert.equal(host.approvalFor('echo_echo', {}), undefined)

    const listed = await host.scriptTools({ cwd: '/proj' })
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ['echo_echo', 'writer_save', 'paths_copy']
    )
    assert.deepEqual(
      listed.tools.map((tool) => tool.skill),
      ['echo', 'writer', 'paths']
    )
    assert.deepEqual(
      listed.tools.map((tool) => tool.approval),
      ['read', 'write', 'read']
    )
    assert.deepEqual(listed.tools[0]?.attachTo, ['main', 'Database'])
    assert.deepEqual(listed.tools[1]?.attachTo, ['main'])
    assert.equal(listed.tools[0]?.parameters.type, 'object')
    assert.equal(
      (listed.tools[0]?.parameters.properties as { message?: { type?: string } } | undefined)
        ?.message?.type,
      'string'
    )
    assert.equal(listed.problems.length, 2)
    assert.ok(
      listed.problems.some((problem) => problem === "duplicate script tool name 'echo_echo'")
    )
    assert.equal(
      listed.problems.filter((problem) => problem.includes("invalid skill 'broken'")).length,
      1
    )
    assert.match(listed.problems.join('\n'), /SKILL.md/)

    assert.equal(host.approvalFor('skill_run', {}), 'exec')
    assert.equal(host.approvalFor('echo_echo', { message: 'hi' }), 'read')
    assert.equal(host.approvalFor('writer_save', {}), 'write')
    assert.equal(host.approvalFor('paths_copy', {}), 'write')
    assert.equal(host.approvalFor('paths_copy', { dest: 'out.txt' }), 'write')
    assert.equal(host.approvalFor('bash', { command: 'ls' }), undefined)
    assert.equal(host.approvalFor('missing_tool', {}), undefined)
  })
})

test('skills.run returns the script result when the environment is ready', async () => {
  await withFixture(
    async ({ host, projectDir, root, environmentsDir, dirs }) => {
      const skill = validateSkill(dirs[0])
      assert.ok(skill.skill)
      const descriptor = describeEnvironment('phi:python@1', {
        skill: skill.skill,
        environmentsDir,
        platform: currentPlatform()
      })
      const result = await host.run({
        requestId: 'run-1',
        cwd: projectDir,
        skill: 'echo',
        script: 'echo.py',
        args: ['--limit', '2']
      })
      assert.equal(isNotReady(result), false)
      if (isNotReady(result)) return
      assert.equal(result.exitCode, 0)
      assert.equal(result.terminated, undefined)
      assert.deepEqual(result.warnings, [])
      assert.equal(result.envId, envIdFor(descriptor))
      assert.equal(result.resolvedCommand, join(root, 'envs', result.envId, 'bin', 'python'))
      const parsed = JSON.parse(result.stdout) as { argv: string[]; cwd: string }
      assert.equal(parsed.argv[1], '--limit')
      assert.equal(parsed.argv[2], '2')
      assert.equal(parsed.cwd, realpathSync(projectDir))

      await host.scriptTools({ cwd: projectDir })
      const tool = await host.scriptTool({
        requestId: 'tool-1',
        cwd: projectDir,
        tool: 'echo_echo',
        args: { message: 'hi' }
      })
      assert.equal(tool.ok, true)
      if (tool.ok) {
        const argv = tool.output.argv as string[]
        assert.deepEqual(argv.slice(-2), ['--message', 'hi'])
      }
    },
    { ready: true }
  )
})

test('skills.run reports an environment the user must build', async () => {
  await withFixture(async ({ host, projectDir }) => {
    const result = await host.run({
      requestId: 'run-missing',
      cwd: projectDir,
      skill: 'echo',
      script: 'echo.py'
    })
    assert.equal(isNotReady(result), true)
    if (!isNotReady(result)) return
    assert.equal(result.notReady.ref, 'phi:python@1')
    assert.match(result.notReady.envId, /^phi-minimal-/)
    assert.match(result.notReady.message, /phi:python@1/)
    assert.match(result.notReady.message, /user must build it first/)
  })
})

test('skills.run rejects an unknown or invalid skill', async () => {
  await withFixture(async ({ host, projectDir }) => {
    await assert.rejects(
      () => host.run({ requestId: 'missing', cwd: projectDir, skill: 'nope', script: 'echo.py' }),
      /unknown skill 'nope'/
    )
    await assert.rejects(
      () => host.run({ requestId: 'bad', cwd: projectDir, skill: 'broken', script: 'echo.py' }),
      /invalid skill 'broken'/
    )
  })
})

test('skills.cancel aborts a sleeping script', { timeout: 20_000 }, async () => {
  await withFixture(
    async ({ host, projectDir, dirs }) => {
      writeFileSync(join(dirs[0], 'scripts', 'sleep.sh'), 'sleep 30\n')
      const pending = host.run({
        requestId: 'sleep-1',
        cwd: projectDir,
        skill: 'echo',
        script: 'sleep.sh'
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      host.cancel({ requestId: 'sleep-1' })
      const result = await pending
      assert.equal(isNotReady(result), false)
      if (isNotReady(result)) return
      assert.equal(result.terminated, 'aborted')
      assert.equal(result.exitCode, null)
    },
    { ready: true }
  )
})

function buildingRecord(envId: string): EnvironmentBuild {
  return {
    envId,
    ref: 'phi:python@1',
    state: 'building',
    phase: 'create',
    message: 'downloading',
    startedAt: '2026-09-30T00:00:00.000Z',
    estimate: { packages: 2, cachedPackages: 0, downloadBytes: 100, remainingBytes: 100 },
    progress: { packagesDone: 0, packages: 2, bytesDone: 0, bytesTotal: 100 }
  }
}

function handleFor(root: string, envId: string): EnvHandle {
  const metadata = JSON.parse(
    readFileSync(join(root, 'envs', envId, '.phi', 'env.json'), 'utf8')
  ) as EnvHandle['metadata']
  return { envId, prefix: join(root, 'envs', envId), metadata }
}

function installPython(root: string, spec: Parameters<EnvironmentBuilds['start']>[0]): EnvHandle {
  const printer = join(root, 'print-argv.cjs')
  writeFileSync(
    printer,
    'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n")\n'
  )
  const envId = installReady(root, spec, {
    python: argvShell(process.execPath, printer, join(root, 'ran'))
  })
  return handleFor(root, envId)
}

test('a running build is joined without asking again', async () => {
  let confirmed = false
  let started: () => void = () => undefined
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve
  })
  let finish: () => void = () => undefined
  await withFixture(
    async ({ host, projectDir }) => {
      const pending = host.run({
        requestId: 'join-1',
        cwd: projectDir,
        skill: 'echo',
        script: 'echo.py',
        runtimeSessionId: 'runtime-1'
      })
      await startedPromise
      assert.equal(confirmed, false)
      finish()
      const result = await pending
      assert.equal(isNotReady(result), false)
      if (isNotReady(result)) return
      assert.equal(result.exitCode, 0)
    },
    {
      confirmBuild: async () => {
        confirmed = true
        return true
      },
      builds: ({ root, environmentsDir, platform }) => {
        const spec = describeEnvironment('phi:python@1', { environmentsDir, platform })
        return {
          list: () => [buildingRecord(envIdFor(spec))],
          cancel() {
            throw new Error('the running build must keep going')
          },
          start(next) {
            return new Promise((resolve) => {
              finish = () => resolve(installPython(root, next))
              started()
            })
          }
        }
      }
    }
  )
})

test('confirming a build installs the environment and runs the script', async () => {
  const starts: string[] = []
  await withFixture(
    async ({ host, projectDir }) => {
      const result = await host.run({
        requestId: 'build-1',
        cwd: projectDir,
        skill: 'echo',
        script: 'echo.py',
        args: ['--limit', '2'],
        runtimeSessionId: 'runtime-1'
      })
      assert.equal(isNotReady(result), false)
      if (isNotReady(result)) return
      assert.equal(result.exitCode, 0)
      assert.equal(starts.length, 1)

      await host.scriptTools({ cwd: projectDir })
      const tool = await host.scriptTool({
        requestId: 'build-tool',
        cwd: projectDir,
        tool: 'echo_echo',
        args: { message: 'hi' },
        runtimeSessionId: 'runtime-1'
      })
      assert.equal(tool.ok, true)
    },
    {
      confirmBuild: async (request) => {
        assert.equal(request.runtimeSessionId, 'runtime-1')
        assert.equal(request.ref, 'phi:python@1')
        assert.equal(request.skill, 'echo')
        assert.equal(typeof request.estimate.packages, 'number')
        assert.ok(request.estimate.packages > 0)
        return true
      },
      builds: ({ root }) => ({
        list: () => [],
        cancel() {
          return undefined
        },
        async start(spec) {
          starts.push(spec.ref)
          return installPython(root, spec)
        }
      })
    }
  )
})

test('declining a build reports that the user declined', async () => {
  await withFixture(
    async ({ host, projectDir }) => {
      const result = await host.run({
        requestId: 'no-1',
        cwd: projectDir,
        skill: 'echo',
        script: 'echo.py',
        runtimeSessionId: 'runtime-1'
      })
      assert.equal(isNotReady(result), true)
      if (!isNotReady(result)) return
      assert.equal(
        result.notReady.message,
        'environment phi:python@1 is not built; the user declined to build it now'
      )

      await host.scriptTools({ cwd: projectDir })
      const tool = await host.scriptTool({
        requestId: 'no-tool',
        cwd: projectDir,
        tool: 'echo_echo',
        args: { message: 'hi' },
        runtimeSessionId: 'runtime-1'
      })
      assert.equal(tool.ok, false)
      if (!tool.ok) {
        assert.equal(
          tool.error,
          'environment phi:python@1 is not built; the user declined to build it now'
        )
      }
    },
    {
      confirmBuild: async () => false,
      builds: () => ({
        list: () => [],
        cancel() {
          return undefined
        },
        start() {
          throw new Error('declined builds must not start')
        }
      })
    }
  )
})

test('without runtimeSessionId the call stays not-ready and does not build', async () => {
  let asked = false
  await withFixture(
    async ({ host, projectDir }) => {
      const result = await host.run({
        requestId: 'plain',
        cwd: projectDir,
        skill: 'echo',
        script: 'echo.py'
      })
      assert.equal(isNotReady(result), true)
      if (!isNotReady(result)) return
      assert.match(result.notReady.message, /user must build it first/)
      assert.equal(asked, false)

      await host.scriptTools({ cwd: projectDir })
      const tool = await host.scriptTool({
        requestId: 'plain-tool',
        cwd: projectDir,
        tool: 'echo_echo',
        args: { message: 'hi' }
      })
      assert.equal(tool.ok, false)
      if (!tool.ok) assert.equal(tool.error, 'environment phi:python@1 is not ready')
    },
    {
      confirmBuild: async () => {
        asked = true
        return true
      },
      builds: () => ({
        list: () => [],
        cancel() {
          return undefined
        },
        start() {
          throw new Error('must not build without a runtime session')
        }
      })
    }
  )
})

test('aborting while a build is awaited returns aborted and leaves the build running', async () => {
  let cancelled = false
  let started: () => void = () => undefined
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve
  })
  let finish: (() => void) | undefined
  let continued = false
  await withFixture(
    async ({ host, projectDir }) => {
      const pending = host.run({
        requestId: 'abort-build',
        cwd: projectDir,
        skill: 'echo',
        script: 'echo.py',
        runtimeSessionId: 'runtime-1'
      })
      await startedPromise
      host.cancel({ requestId: 'abort-build' })
      const result = await pending
      assert.equal(isNotReady(result), false)
      if (isNotReady(result)) return
      assert.equal(result.terminated, 'aborted')
      assert.equal(cancelled, false)
      assert.equal(continued, false)
      finish?.()
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(continued, true)
    },
    {
      confirmBuild: async () => true,
      builds: ({ root }) => ({
        list: () => [],
        cancel() {
          cancelled = true
        },
        start(spec) {
          return new Promise((resolve) => {
            finish = () => {
              continued = true
              resolve(installPython(root, spec))
            }
            started()
          })
        }
      })
    }
  )
})

test('a failed build is returned as not-ready with the build error', async () => {
  await withFixture(
    async ({ host, projectDir }) => {
      const result = await host.run({
        requestId: 'fail-1',
        cwd: projectDir,
        skill: 'echo',
        script: 'echo.py',
        runtimeSessionId: 'runtime-1'
      })
      assert.equal(isNotReady(result), true)
      if (!isNotReady(result)) return
      assert.equal(
        result.notReady.message,
        'environment phi:python@1 is not ready; solver exploded'
      )
    },
    {
      confirmBuild: async () => true,
      builds: () => ({
        list: () => [],
        cancel() {
          return undefined
        },
        start() {
          return Promise.reject(new Error('solver exploded'))
        }
      })
    }
  )
})

test('script tools present one valid artifact and warn about the invalid one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-skill-artifacts-'))
  try {
    const projectDir = join(root, 'project')
    const environmentsDir = join(root, 'environments')
    mkdirSync(join(projectDir, 'figures'), { recursive: true })
    copyMinimal(join(environmentsDir, 'phi-python'))
    const platform = currentPlatform()
    const dir = join(root, 'echo')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'echo.py'), 'print(1)\n')
    writeFileSync(
      join(dir, 'SKILL.md'),
      skillMarkdown({
        name: 'echo',
        description: 'Echo script arguments as JSON.',
        toolPrefix: 'echo',
        scriptName: 'echo',
        scriptDescription: 'Print the flags passed to the script as JSON.',
        scriptFile: 'echo.py',
        approval: 'read',
        args: MESSAGE_ARGS
      })
    )
    const plot = join(projectDir, 'figures', 'plot.png')
    writeFileSync(plot, 'png')
    const descriptorText = `${JSON.stringify({
      contractVersion: '1.0.0',
      kind: 'figure',
      file: 'plot.png',
      mediaType: 'image/png',
      title: 'Volcano plot',
      provenance: { createdAt: '2026-09-30T09:11:00Z', tool: 'viz_render' },
      figure: { format: 'png' }
    })}\n`
    const descriptorPath = `${plot}.phi-artifact.json`
    writeFileSync(descriptorPath, descriptorText)
    const printer = join(root, 'print-artifacts.cjs')
    const payload = JSON.stringify({
      artifacts: ['figures/plot.png', 'figures/missing.png'],
      value: 1
    })
    writeFileSync(printer, `process.stdout.write(${JSON.stringify(payload)})\n`)
    const skill = validateSkill(dir)
    assert.equal(skill.ok, true, JSON.stringify(skill.errors))
    assert.ok(skill.skill)
    const environment = describeEnvironment('phi:python@1', {
      skill: skill.skill,
      environmentsDir,
      platform
    })
    installReady(root, environment, {
      python: shell([`exec ${shQuote(process.execPath)} ${shQuote(printer)} "$@"`])
    })
    const presented: Array<{
      runtimeSessionId: string
      toolCallId: string
      count: number
      envId: string
      path: string
      title: string
    }> = []
    const host = createSkillHost({
      runtimeRoot: root,
      environmentsDir,
      platform,
      listSkillDirs: async () => [dir],
      presentArtifacts: (request) => {
        const artifact = request.artifacts[0]
        presented.push({
          runtimeSessionId: request.runtimeSessionId,
          toolCallId: request.toolCallId,
          count: request.artifacts.length,
          envId: request.envId,
          path: artifact?.relativePath ?? '',
          title: artifact?.descriptor.title ?? ''
        })
        assert.equal('envId' in (artifact?.descriptor ?? {}), false)
      }
    })
    await host.scriptTools({ cwd: projectDir })
    const result = await host.scriptTool({
      requestId: 'art-1',
      cwd: projectDir,
      tool: 'echo_echo',
      args: { message: 'hi' },
      runtimeSessionId: 'runtime-1',
      toolCallId: 'call-1'
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.output.artifacts, ['figures/plot.png', 'figures/missing.png'])
    assert.deepEqual(result.presented, ['figures/plot.png'])
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0] ?? '', /figures\/missing\.png/)
    assert.match(result.warnings[0] ?? '', /does not exist/)
    assert.equal(presented.length, 1)
    assert.equal(presented[0]?.runtimeSessionId, 'runtime-1')
    assert.equal(presented[0]?.toolCallId, 'call-1')
    assert.equal(presented[0]?.count, 1)
    assert.equal(presented[0]?.path, 'figures/plot.png')
    assert.equal(presented[0]?.title, 'Volcano plot')
    assert.equal(presented[0]?.envId, result.envId)
    assert.equal(readFileSync(descriptorPath, 'utf8'), descriptorText)

    await host.scriptTool({
      requestId: 'art-2',
      cwd: projectDir,
      tool: 'echo_echo',
      args: { message: 'hi' },
      toolCallId: 'call-2'
    })
    await host.scriptTool({
      requestId: 'art-3',
      cwd: projectDir,
      tool: 'echo_echo',
      args: { message: 'hi' },
      runtimeSessionId: 'runtime-1'
    })
    assert.equal(presented.length, 1)

    // A presentation failure (for example no active conversation) must not fail the call.
    const failingHost = createSkillHost({
      runtimeRoot: root,
      environmentsDir,
      platform,
      listSkillDirs: async () => [dir],
      presentArtifacts: () => {
        throw new Error('No active conversation for file delivery')
      }
    })
    await failingHost.scriptTools({ cwd: projectDir })
    const failed = await failingHost.scriptTool({
      requestId: 'art-4',
      cwd: projectDir,
      tool: 'echo_echo',
      args: { message: 'hi' },
      runtimeSessionId: 'runtime-1',
      toolCallId: 'call-4'
    })
    assert.equal(failed.ok, true)
    if (!failed.ok) return
    assert.ok(
      failed.warnings.some((warning) =>
        warning.includes('artifacts were not presented: No active conversation')
      )
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
