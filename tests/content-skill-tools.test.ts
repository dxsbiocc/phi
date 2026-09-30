import assert from 'node:assert/strict'
import test from 'node:test'

import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import {
  buildScriptTools,
  buildSkillRunTool,
  type SkillHostRequest
} from '../src/main/agent/content/skill-tools'
import type { ScriptToolDescriptor } from '../src/main/agent/content/skill-tool-types'

const cwd = '/proj'

function ctx(): { sessionManager: { getCwd: () => string } } {
  return { sessionManager: { getCwd: () => cwd } }
}

async function execute(
  tool: CustomTool,
  params: unknown,
  signal?: AbortSignal
): Promise<{
  content: Array<{ type: string; text: string }>
  isError?: boolean
  details?: unknown
}> {
  return tool.execute('call-1', params, undefined, ctx() as never, signal) as Promise<{
    content: Array<{ type: string; text: string }>
    isError?: boolean
    details?: unknown
  }>
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((block) => block.text).join('')
}

function skillRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    envId: 'env-1',
    resolvedCommand: '/env/bin/python /skill/scripts/run.py',
    exitCode: 0,
    stdout: 'hello\n',
    stderr: '',
    truncated: { stdout: false, stderr: false },
    durationMs: 12,
    warnings: [],
    ...overrides
  }
}

function descriptor(overrides: Partial<ScriptToolDescriptor> = {}): ScriptToolDescriptor {
  return {
    name: 'echo_echo',
    description: 'Print a message.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: { message: { type: 'string' } }
    },
    attachTo: ['main'],
    skill: 'echo',
    approval: 'read',
    ...overrides
  }
}

test('skill_run parameters follow the contract and execute formats the host result', async () => {
  const calls: Array<{ method: string; params: unknown }> = []
  const request: SkillHostRequest = async (method, params) => {
    calls.push({ method, params })
    return skillRun({ warnings: ['skill echo declares no environment'] })
  }
  const tool = buildSkillRunTool(request)
  assert.equal(tool.name, 'skill_run')
  assert.equal(tool.approval, 'exec')
  assert.equal(tool.strict, undefined)
  assert.deepEqual(tool.parameters, {
    type: 'object',
    additionalProperties: false,
    required: ['skill', 'script'],
    properties: {
      skill: { type: 'string', description: 'Installed, enabled skill name.' },
      script: {
        type: 'string',
        description: 'Path relative to the skill scripts/ directory.'
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments passed verbatim after the script path.'
      },
      cwd: {
        type: 'string',
        description: 'Project-relative working directory. Defaults to the project root.'
      }
    }
  })

  const result = await execute(tool, {
    skill: 'echo',
    script: 'run.py',
    args: ['--limit', '2'],
    cwd: 'nested'
  })
  assert.equal(result.isError, undefined)
  assert.equal(
    textOf(result),
    [
      'exit code: 0',
      'env: env-1',
      'command: /env/bin/python /skill/scripts/run.py',
      'durationMs: 12',
      'warnings:',
      '- skill echo declares no environment',
      'stdout:',
      'hello',
      '',
      'stderr:',
      ''
    ].join('\n')
  )
  const sent = calls[0]?.params as Record<string, unknown>
  assert.equal(calls[0]?.method, 'skills.run')
  assert.equal(sent.cwd, cwd)
  assert.equal(sent.skill, 'echo')
  assert.equal(sent.script, 'run.py')
  assert.deepEqual(sent.args, ['--limit', '2'])
  assert.equal(sent.runCwd, 'nested')
  assert.equal('sessionEnvironment' in sent, false)
  assert.equal(typeof sent.requestId, 'string')
})

test('skill_run is an error when the process fails, is terminated, or the environment is not ready', async () => {
  const cases = [
    skillRun({ exitCode: 1, stdout: '', stderr: 'boom' }),
    skillRun({ exitCode: null, terminated: 'aborted', stdout: '', stderr: '' }),
    {
      notReady: {
        ref: 'phi:python@1',
        envId: 'phi-minimal-abc',
        message: 'environment phi:python@1 is not ready; the user must build it first'
      }
    }
  ]
  for (const payload of cases) {
    const request: SkillHostRequest = async () => payload
    const result = await execute(buildSkillRunTool(request), { skill: 'echo', script: 'run.py' })
    assert.equal(result.isError, true)
    if ('notReady' in payload) {
      assert.match(textOf(result), /phi:python@1/)
      assert.match(textOf(result), /user must build it first/)
    } else if (payload.terminated === 'aborted') {
      assert.match(textOf(result), /terminated: aborted/)
      assert.match(textOf(result), /exit code: null/)
    } else {
      assert.match(textOf(result), /exit code: 1/)
    }
  }

  const failing: SkillHostRequest = async () => {
    throw new Error("unknown skill 'nope'")
  }
  const rejected = await execute(buildSkillRunTool(failing), { skill: 'nope', script: 'run.py' })
  assert.equal(rejected.isError, true)
  assert.match(textOf(rejected), /unknown skill 'nope'/)
})

test('skill_run cancels the host run when the tool call aborts', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let release: (value: unknown) => void = () => undefined
  const request: SkillHostRequest = (method, params) => {
    calls.push({ method, params: params as Record<string, unknown> })
    if (method === 'skills.cancel') return Promise.resolve(null)
    return new Promise((resolve) => {
      release = resolve
    })
  }
  const controller = new AbortController()
  const pending = execute(
    buildSkillRunTool(request),
    { skill: 'echo', script: 'sleep.sh' },
    controller.signal
  )
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  release(skillRun())
  await pending
  const run = calls.find((call) => call.method === 'skills.run')
  const cancel = calls.find((call) => call.method === 'skills.cancel')
  assert.ok(run)
  assert.ok(cancel)
  assert.equal(cancel.params.requestId, run.params.requestId)
})

test('script tools copy the descriptor and set strict only for a compatible schema', async () => {
  const open = descriptor({
    name: 'paths_copy',
    description: 'Copy a file.',
    approval: 'read',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['dest'],
      properties: { dest: { type: 'string', format: 'project-path' } }
    }
  })
  const optional = descriptor({
    name: 'echo_extra',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: { message: { type: 'string' }, extra: { type: 'string' } }
    }
  })
  const calls: unknown[] = []
  const request: SkillHostRequest = async (method, params) => {
    calls.push({ method, params })
    return { ok: true, output: { value: 1 }, envId: 'env-1', warnings: ['kept the host'] }
  }
  const tools = buildScriptTools([descriptor(), open, optional], request)
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.strict, tool.approval, tool.description]),
    [
      ['echo_echo', true, 'read', 'Print a message.'],
      ['paths_copy', undefined, 'read', 'Copy a file.'],
      ['echo_extra', undefined, 'read', 'Print a message.']
    ]
  )
  assert.deepEqual(tools[0]?.parameters, descriptor().parameters)

  const ok = await execute(tools[0] as CustomTool, { message: 'hi' })
  assert.equal(ok.isError, undefined)
  assert.equal(textOf(ok), '{\n  "value": 1\n}\n\nwarnings:\n- kept the host')
  const sent = (calls[0] as { params: Record<string, unknown> }).params
  assert.equal(sent.tool, 'echo_echo')
  assert.equal(sent.cwd, cwd)
  assert.deepEqual(sent.args, { message: 'hi' })
  assert.equal('sessionEnvironment' in sent, false)

  const failing: SkillHostRequest = async () => ({
    ok: false,
    error: 'disk full',
    envId: 'env-1',
    warnings: []
  })
  const error = await execute(buildScriptTools([descriptor()], failing)[0] as CustomTool, {})
  assert.equal(error.isError, true)
  assert.equal(textOf(error), 'disk full')
})
