import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { describeEnvironment, validateSkill } from '../src/main/agent/content'
import { createSkillHost, type SkillHost } from '../src/main/agent/content/skill-host'
import { currentPlatform } from '../src/main/agent/envs'
import { argvShell, copyMinimal, envIdFor, installReady, shell } from './helpers/fakeEnvironment'

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
  options: { ready?: boolean } = {}
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
      listSkillDirs: async () => dirs
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
