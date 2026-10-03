import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createEnvironmentBindingExtension,
  reduceToolCallResults,
  rewriteBoundBashInput,
  type ToolCallRewrite
} from '../src/main/agent/agents/environment-binding'
import { buildEnvironment, describeEnvironment, readyEnvironment } from '../src/main/agent/content'
import { currentPlatform, environmentVariables, removeTree } from '../src/main/agent/envs'
import { getMicromambaPath } from '../src/main/agent/envs/paths'
import { copyMinimal, installReady, shell } from './helpers/fakeEnvironment'
import { createTestRuntimeRoot } from './helpers/testRuntimeRoot'

const REF = 'phi:python@1'

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string') out[name] = value
  }
  return out
}

function bindingHandler(
  variables: Record<string, string>,
  hostEnv: Record<string, string>
): (event: { toolName: string; input: unknown }) => ToolCallRewrite | undefined {
  let handler:
    ((event: { toolName: string; input: unknown }) => ToolCallRewrite | undefined) | undefined
  createEnvironmentBindingExtension({ ref: REF, variables, hostEnv })({
    on(event, fn) {
      if (event === 'tool_call') handler = fn as NonNullable<typeof handler>
    }
  } as never)
  if (!handler) throw new Error('binding extension did not register tool_call')
  return handler
}

function commandOf(event: { input: unknown }): string {
  const input = event.input as { command?: unknown }
  return typeof input.command === 'string' ? input.command : ''
}

test('bash rewrites keep explicit extras, force reserved names, and drop host leaks', () => {
  const bin = '/tmp/phi-env/bin'
  const variables = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: '/Users/tester',
    PYTHONNOUSERSITE: '1'
  }
  const rewritten = rewriteBoundBashInput(
    {
      command: 'echo hi',
      cwd: '/work',
      env: { PATH: '/evil', PYTHONPATH: '/from-call', FOO: 'kept', NOT_A_STRING: 1 }
    },
    {
      ref: REF,
      variables,
      hostEnv: {
        HOME: '/Users/tester',
        PATH: '/host/bin',
        PYTHONPATH: '/host/leak',
        PHI_TEST_HOST_SECRET: '1',
        'BAD-NAME': 'nope'
      }
    }
  )
  assert.ok(rewritten)
  const env = rewritten.env as Record<string, string>
  assert.equal(env.PATH, variables.PATH)
  assert.equal(env.PATH.startsWith(`${bin}:`), true)
  assert.equal(env.PYTHONPATH, undefined)
  assert.equal(env.PYTHONNOUSERSITE, '1')
  assert.equal(env.FOO, 'kept')
  assert.equal(env.HOME, '/Users/tester')
  assert.equal(rewritten.cwd, '/work')
  assert.equal(rewritten.command, 'unset -v PHI_TEST_HOST_SECRET PYTHONPATH; echo hi')
})

test('pty and async bash calls use the same rewrite', () => {
  const rewritten = rewriteBoundBashInput(
    { command: 'echo hi', pty: true, async: true },
    {
      ref: REF,
      variables: { PATH: '/env/bin:/usr/bin:/bin' },
      hostEnv: { PHI_TEST_HOST_SECRET: '1' }
    }
  )
  assert.ok(rewritten)
  assert.equal(rewritten.pty, true)
  assert.equal(rewritten.async, true)
  assert.equal(rewritten.command, 'unset -v PHI_TEST_HOST_SECRET; echo hi')
})

test('non-bash tool calls are left untouched', () => {
  const handler = bindingHandler({ PATH: '/env/bin' }, {})
  assert.equal(handler({ toolName: 'read', input: { path: 'notes.txt' } }), undefined)
  assert.equal(
    rewriteBoundBashInput({ command: 1 }, { ref: REF, variables: {}, hostEnv: {} }),
    undefined
  )
})

test('approval and the plan guard see the original command; the binding result is last', async () => {
  // Mirrors ExtensionRunner.emitToolCall: each handler receives the original
  // event, the last result wins, and { block: true } returns immediately.
  const event = { toolName: 'bash', input: { command: 'echo original', env: { FOO: '1' } } }
  const seen: string[] = []
  const binding = bindingHandler({ PATH: '/env/bin:/usr/bin:/bin', HOME: '/Users/tester' }, {})
  const result = await reduceToolCallResults(event, [
    (next) => {
      seen.push(`plan:${commandOf(next)}`)
      return undefined
    },
    (next) => {
      seen.push(`approval:${commandOf(next)}`)
      return { input: { command: 'echo approved-display' } }
    },
    (next) => {
      seen.push(`binding:${commandOf(next)}`)
      return binding(next)
    }
  ])
  assert.deepEqual(seen, ['plan:echo original', 'approval:echo original', 'binding:echo original'])
  const input = result?.input as { command: string; env: Record<string, string> }
  assert.equal(input.command, 'echo original')
  assert.equal(input.env.FOO, '1')
  assert.equal(input.env.PATH, '/env/bin:/usr/bin:/bin')
  assert.notEqual(input.command, 'echo approved-display')
})

test('a blocking plan guard stops before the binding rewrite', async () => {
  let called = false
  const result = await reduceToolCallResults(
    { toolName: 'bash', input: { command: 'echo original' } },
    [
      () => ({ block: true, reason: 'plan mode' }),
      () => {
        called = true
        return { input: { command: 'rewritten' } }
      }
    ]
  )
  assert.equal(result?.block, true)
  assert.equal(result?.reason, 'plan mode')
  assert.equal(called, false)
})

test('the rewritten command runs with the environment and without host leaks', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-agent-bind-'))
  try {
    const environmentsDir = join(root, 'environments')
    copyMinimal(join(environmentsDir, 'phi-python'))
    const descriptor = describeEnvironment(REF, {
      environmentsDir,
      platform: currentPlatform()
    })
    const envId = installReady(root, descriptor, {
      python: shell(['echo phi-python-marker'])
    })
    const handle = readyEnvironment(root, descriptor)
    const bin = join(handle.prefix, 'bin')
    const variables = environmentVariables(handle, {
      baseEnv: { HOME: '/Users/tester', USER: 'tester', LANG: 'C.UTF-8' }
    })
    assert.equal(envId, handle.envId)
    assert.equal(variables.PATH.startsWith(`${bin}:`), true)
    const hostEnv = {
      HOME: '/Users/tester',
      USER: 'tester',
      PATH: '/host/bin:/usr/bin:/bin',
      PYTHONPATH: '/host/leak',
      PHI_TEST_HOST_SECRET: '1',
      LANG: 'C.UTF-8'
    }
    const rewritten = rewriteBoundBashInput(
      {
        command:
          'printf "python=%s\\nsecret=%s\\npythonpath=%s\\nhome=%s\\npath=%s\\nfoo=%s\\n" "$(command -v python)" "${PHI_TEST_HOST_SECRET-}" "${PYTHONPATH-}" "${HOME-}" "$PATH" "${FOO-}"\npython',
        env: { PATH: '/evil', PYTHONPATH: '/from-call', FOO: 'kept' }
      },
      { ref: REF, variables, hostEnv }
    )
    assert.ok(rewritten)
    assert.equal((rewritten.env as Record<string, string>).PATH, variables.PATH)
    // omp Shell.run merges `env` over the process environment, so the spawn
    // env is the host plus the overlay. The unset prefix removes the rest.
    const ran = spawnSync('/bin/bash', ['-c', String(rewritten.command)], {
      env: { ...hostEnv, ...(rewritten.env as Record<string, string>) },
      encoding: 'utf8'
    })
    assert.equal(ran.status, 0, ran.stderr)
    const lines = Object.fromEntries(
      ran.stdout
        .trim()
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => {
          const index = line.indexOf('=')
          return [line.slice(0, index), line.slice(index + 1)]
        })
    )
    assert.equal(lines.python, join(bin, 'python'))
    assert.equal(lines.secret, '')
    assert.equal(lines.pythonpath, '')
    assert.equal(lines.home, '/Users/tester')
    assert.equal(lines.path.startsWith(`${bin}:`), true)
    assert.equal(lines.foo, 'kept')
    assert.match(ran.stdout, /phi-python-marker/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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

test(
  'integration: a bound bash call uses the built environment prefix',
  { timeout: 600_000, skip: integrationSkipReason() },
  async () => {
    const root = createTestRuntimeRoot('agent-bind')
    try {
      const runtimeRoot = realpathSync(root)
      const environmentsDir = join(runtimeRoot, 'environments')
      copyMinimal(join(environmentsDir, 'phi-python'))
      const descriptor = describeEnvironment(REF, {
        environmentsDir,
        platform: currentPlatform()
      })
      const handle = await buildEnvironment(runtimeRoot, descriptor)
      const variables = environmentVariables(handle)
      const hostEnv = definedEnv({
        ...process.env,
        PYTHONPATH: '/host/leak',
        PHI_TEST_HOST_SECRET: '1'
      })
      const rewritten = rewriteBoundBashInput(
        { command: 'python -c "import sys; print(sys.prefix)"' },
        { ref: descriptor.ref, variables, hostEnv }
      )
      assert.ok(rewritten)
      const ran = spawnSync('/bin/bash', ['-c', String(rewritten.command)], {
        env: { ...hostEnv, ...(rewritten.env as Record<string, string>) },
        encoding: 'utf8'
      })
      assert.equal(ran.status, 0, ran.stderr)
      assert.equal(realpathSync(ran.stdout.trim()), realpathSync(handle.prefix))
    } finally {
      removeTree(root)
    }
  }
)
