import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createCheckEnvironmentExtension,
  parseShellEnvironment,
  type CheckEnvironmentDetails,
  type ProbeResult,
  type ProbeRunner,
  type ProbeRunOptions,
  type ShellEnvironment
} from '../src/main/agent/engine/phi-extension'
import type { PhiExtensionHost } from '../src/main/agent/engine/phi-extension'
import {
  defaultProbeRunner,
  probePython,
  resolveCommand
} from '../src/main/agent/engine/phi-extension/lib/check-environment'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  details?: CheckEnvironmentDetails
  isError?: boolean
}

interface RegisteredTool {
  name: string
  label: string
  description: string
  parameters: unknown
  defaultInactive?: boolean
  loadMode?: string
  approval?: string
  strict?: boolean
  execute: (toolCallId: string, input: unknown) => Promise<ToolResult>
}

function host(overrides: Partial<PhiExtensionHost> = {}): PhiExtensionHost {
  return {
    nextActionSuggestionsEnabled: async () => false,
    planModeActive: () => false,
    planExecuteModeActive: () => false,
    proposePlanSteps: async () => ({ content: [] }),
    requestToolApproval: async () => undefined,
    browserApprovalInput: (_toolCallId, input) => input,
    markBrowserTextDenied: () => undefined,
    fallbackReadiness: () => ({ allowed: true, failures: 0 }),
    environmentBinding: () => undefined,
    hostEnvironment: () => ({}),
    ...overrides
  }
}

function hostEnvironmentRecord(extensionHost: PhiExtensionHost): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(extensionHost.hostEnvironment())) {
    if (value !== undefined) environment[name] = value
  }
  return environment
}

async function register(
  extensionHost: PhiExtensionHost,
  options: { runner?: ProbeRunner; cwd?: string; shellEnvironment?: ShellEnvironment } = {}
): Promise<RegisteredTool> {
  let tool: RegisteredTool | undefined
  await createCheckEnvironmentExtension(extensionHost, {
    ...options,
    shellEnvironment: options.shellEnvironment ?? (async () => hostEnvironmentRecord(extensionHost))
  })({
    registerTool: (definition: RegisteredTool) => {
      tool = definition
    }
  } as never)
  assert.ok(tool)
  return tool
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'phi-check-environment-'))
}

async function executable(directory: string, name: string): Promise<string> {
  const path = join(directory, name)
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, 0o755)
  return path
}

function text(result: ToolResult): string {
  return result.content.map((part) => part.text).join('\n')
}

test('check_environment registers a strict, essential read-only tool', async () => {
  const tool = await register(host())
  assert.equal(tool.name, 'check_environment')
  assert.equal(tool.label, 'Check environment')
  assert.match(tool.description, /read-only/i)
  assert.match(tool.description, /never installs/i)
  assert.equal(tool.defaultInactive, true)
  assert.equal(tool.loadMode, 'essential')
  assert.equal(tool.approval, 'read')
  assert.equal(tool.strict, true)
  const parameters = tool.parameters as {
    additionalProperties: boolean
    anyOf?: unknown[]
    properties: Record<string, { maxItems: number; uniqueItems: boolean; items: unknown }>
  }
  assert.equal(parameters.additionalProperties, false)
  // Providers reject top-level combinators; emptiness is validated at execution.
  assert.equal(parameters.anyOf, undefined)
  for (const name of ['commands', 'python_modules', 'r_packages']) {
    assert.equal(parameters.properties[name]?.maxItems, 20)
    assert.equal(parameters.properties[name]?.uniqueItems, true)
  }
})

test('commands resolve on PATH without executing anything', async () => {
  const directory = await tempDir()
  const present = await executable(directory, 'phi-present')
  const plain = join(directory, 'phi-plain')
  await writeFile(plain, 'not executable\n')
  await chmod(plain, 0o644)
  try {
    const tool = await register(host({ hostEnvironment: () => ({ PATH: directory }) }), {
      runner: async () => {
        assert.fail('command checks must not execute anything')
      }
    })
    const result = await tool.execute('call-1', {
      commands: ['phi-present', 'phi-plain', 'phi-missing']
    })
    assert.equal(result.isError, undefined)
    assert.deepEqual(
      result.details?.commands.map((item) => item.path),
      [present, null, null]
    )
    const output = text(result)
    assert.match(output, new RegExp(`phi-present: ${present.replaceAll('/', '\\/')}`))
    assert.match(output, /phi-plain: not found/)
    assert.match(output, /phi-missing: not found/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a bound environment PATH wins over the host environment', async () => {
  const hostDirectory = await tempDir()
  const boundDirectory = await tempDir()
  const bound = await executable(boundDirectory, 'phi-bound')
  try {
    const tool = await register(
      host({
        environmentBinding: () => ({
          ref: 'binding-1',
          variables: { PATH: boundDirectory, PHI_BOUND: 'yes' }
        }),
        hostEnvironment: () => ({ PATH: hostDirectory, PHI_HOST: 'no' })
      }),
      {
        shellEnvironment: async () => {
          assert.fail('a bound environment must not read the login shell')
        }
      }
    )
    const result = await tool.execute('call-1', { commands: ['phi-bound'] })
    assert.deepEqual(result.details?.commands, [{ name: 'phi-bound', path: bound }])
    assert.equal(result.details?.environmentSource, 'binding')
    assert.match(text(result), /environment: bound environment binding-1/)
  } finally {
    await rm(hostDirectory, { recursive: true, force: true })
    await rm(boundDirectory, { recursive: true, force: true })
  }
})

test('the login shell environment wins over the host environment', async () => {
  const hostDirectory = await tempDir()
  const shellDirectory = await tempDir()
  const shellCommand = await executable(shellDirectory, 'phi-shell')
  let requestedCwd: string | undefined
  try {
    const tool = await register(
      host({
        hostEnvironment: () => ({ PATH: hostDirectory, PHI_HOST: 'no' })
      }),
      {
        shellEnvironment: async (cwd) => {
          requestedCwd = cwd
          return { PATH: shellDirectory, PHI_SHELL: 'yes' }
        }
      }
    )
    const result = await tool.execute('call-1', { commands: ['phi-shell'] })
    assert.equal(requestedCwd, tmpdir())
    assert.deepEqual(result.details?.commands, [{ name: 'phi-shell', path: shellCommand }])
    assert.equal(result.details?.environmentSource, 'shell')
    assert.match(text(result), /environment: login shell/)
  } finally {
    await rm(hostDirectory, { recursive: true, force: true })
    await rm(shellDirectory, { recursive: true, force: true })
  }
})

test('a failed login shell read falls back to the process environment', async () => {
  const directory = await tempDir()
  const present = await executable(directory, 'phi-present')
  try {
    const tool = await register(host({ hostEnvironment: () => ({ PATH: directory }) }), {
      shellEnvironment: async () => {
        throw new Error('login shell unavailable')
      }
    })
    const result = await tool.execute('call-1', { commands: ['phi-present'] })
    assert.deepEqual(result.details?.commands, [{ name: 'phi-present', path: present }])
    assert.equal(result.details?.environmentSource, 'process')
    assert.match(
      text(result),
      /environment: process \(shell snapshot failed: login shell unavailable\)/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('env -0 output parses NUL-separated pairs, including "=" and newlines', () => {
  assert.deepEqual(
    parseShellEnvironment('PATH=/one:/two\0WEIRD=a=b=c\0MULTILINE=first\nsecond\0EMPTY=\0'),
    {
      PATH: '/one:/two',
      WEIRD: 'a=b=c',
      MULTILINE: 'first\nsecond',
      EMPTY: ''
    }
  )
  assert.throws(() => parseShellEnvironment(''), /no NUL separators/)
  assert.throws(() => parseShellEnvironment('PATH=/one'), /no NUL separators/)
  assert.throws(() => parseShellEnvironment('NOEQUALS\0'), /unexpected environment entry/)
})

test('a login shell without PATH falls back to the process environment', async () => {
  const directory = await tempDir()
  const present = await executable(directory, 'phi-present')
  try {
    const tool = await register(host({ hostEnvironment: () => ({ PATH: directory }) }), {
      shellEnvironment: async () => ({ HOME: directory })
    })
    const result = await tool.execute('call-1', { commands: ['phi-present'] })
    assert.deepEqual(result.details?.commands, [{ name: 'phi-present', path: present }])
    assert.equal(result.details?.environmentSource, 'process')
    assert.match(text(result), /did not report PATH/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('python and R probes use the stub runner and parse its output', async () => {
  const directory = await tempDir()
  const python = await executable(directory, 'python3')
  const rscript = await executable(directory, 'Rscript')
  const calls: Array<{ file: string; args: readonly string[]; options: ProbeRunOptions }> = []
  const runner: ProbeRunner = async (file, args, options): Promise<ProbeResult> => {
    calls.push({ file, args, options })
    if (file === python) {
      return {
        stdout: JSON.stringify({
          python: '3.12.4',
          executable: python,
          modules: {
            numpy: { found: true, version: '2.1.0' },
            statsmodels: { found: false, version: null }
          }
        }),
        stderr: ''
      }
    }
    return {
      stdout:
        'R\tR version 4.4.1 (2024-06-14)\n' + 'stats\ttrue\t4.4.1\n' + 'missingPkg\tfalse\t\n',
      stderr: ''
    }
  }
  try {
    const tool = await register(
      host({ hostEnvironment: () => ({ PATH: directory, PHI_CUSTOM: 'value' }) }),
      { runner, cwd: directory }
    )
    const result = await tool.execute('call-1', {
      python_modules: ['numpy', 'statsmodels'],
      r_packages: ['stats', 'missingPkg']
    })
    assert.equal(result.isError, undefined)
    assert.equal(calls.length, 2)

    const pythonCall = calls.find((call) => call.file === python)
    assert.ok(pythonCall)
    assert.equal(pythonCall.args[0], '-c')
    assert.match(String(pythonCall.args[1]), /del sys\.path\[0\]/)
    assert.match(String(pythonCall.args[1]), /importlib\.util\.find_spec/)
    assert.match(String(pythonCall.args[1]), /packages_distributions/)
    assert.match(String(pythonCall.args[1]), /importlib\.metadata\.version/)
    assert.deepEqual(pythonCall.args.slice(2), ['numpy', 'statsmodels'])
    assert.equal(pythonCall.options.shell, false)
    assert.equal(pythonCall.options.cwd, directory)
    assert.equal(pythonCall.options.timeout, 20_000)
    assert.equal(pythonCall.options.maxBuffer, 256 * 1024)
    assert.equal(pythonCall.options.env.PATH, directory)
    assert.equal(pythonCall.options.env.PHI_CUSTOM, 'value')

    const rCall = calls.find((call) => call.file === rscript)
    assert.ok(rCall)
    assert.equal(rCall.args[0], '--vanilla')
    assert.equal(rCall.args[1], '-e')
    assert.match(String(rCall.args[2]), /commandArgs\(trailingOnly=TRUE\)/)
    assert.match(String(rCall.args[2]), /system\.file\(package=p\)/)
    assert.deepEqual(rCall.args.slice(3), ['stats', 'missingPkg'])
    assert.equal(rCall.options.shell, false)
    assert.equal(rCall.options.env.PATH, directory)

    const output = text(result)
    assert.match(output, /python: 3\.12\.4 at /)
    assert.match(output, /numpy: 2\.1\.0/)
    assert.match(output, /statsmodels: not found/)
    assert.match(output, /r: R version 4\.4\.1/)
    assert.match(output, /stats: 4\.4\.1/)
    assert.match(output, /missingPkg: not found/)

    assert.equal(result.details?.python?.checked, true)
    assert.equal(result.details?.python?.modules[0]?.version, '2.1.0')
    assert.equal(result.details?.python?.modules[1]?.found, false)
    assert.equal(result.details?.r?.checked, true)
    assert.equal(result.details?.r?.packages[0]?.version, '4.4.1')
    assert.equal(result.details?.r?.packages[1]?.found, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a missing interpreter reports every requested item as unchecked', async () => {
  const directory = await tempDir()
  try {
    const tool = await register(host({ hostEnvironment: () => ({ PATH: directory }) }))
    const result = await tool.execute('call-1', {
      python_modules: ['numpy'],
      r_packages: ['stats']
    })
    assert.equal(result.isError, undefined)
    const output = text(result)
    assert.match(output, /python: no python3 or python found on PATH; modules unchecked/)
    assert.match(output, /numpy: unchecked/)
    assert.match(output, /r: Rscript not found on PATH; packages unchecked/)
    assert.match(output, /stats: unchecked/)
    assert.equal(result.details?.python?.checked, false)
    assert.equal(result.details?.python?.modules[0]?.unchecked, true)
    assert.equal(result.details?.r?.checked, false)
    assert.equal(result.details?.r?.packages[0]?.unchecked, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('invalid names and malformed input are rejected inside execute', async () => {
  const tool = await register(host({ hostEnvironment: () => ({ PATH: '/nonexistent' }) }))
  const cases: Array<[unknown, RegExp]> = [
    [{ commands: ['bad name'] }, /commands\[0\]/],
    [{ python_modules: ['1numpy'] }, /python_modules\[0\]/],
    [{ r_packages: ['-stats'] }, /r_packages\[0\]/],
    [{ r_packages: ['stats', 'stats'] }, /duplicates/],
    [{ commands: [], python_modules: [], r_packages: [] }, /at least one/],
    [{ commands: ['python3'], extra: true }, /unknown property/],
    [{}, /at least one/]
  ]
  for (const [input, expected] of cases) {
    const result = await tool.execute('call-1', input)
    assert.equal(result.isError, true, JSON.stringify(input))
    assert.match(text(result), /Invalid check_environment input/)
    assert.match(text(result), expected)
  }
})

test('probe timeouts and bad output become readable per-section messages', async () => {
  const directory = await tempDir()
  const python = await executable(directory, 'python3')
  try {
    const timeout = await register(host({ hostEnvironment: () => ({ PATH: directory }) }), {
      runner: async () => {
        throw Object.assign(new Error('Command failed'), { code: 'ETIMEDOUT', killed: true })
      }
    })
    const timedOut = await timeout.execute('call-1', { python_modules: ['numpy'] })
    assert.equal(timedOut.isError, undefined)
    assert.match(text(timedOut), /python: Python probe timed out after 20s; modules unchecked/)
    assert.match(text(timedOut), /numpy: unchecked/)
    assert.equal(timedOut.details?.python?.checked, false)

    const malformed = await register(host({ hostEnvironment: () => ({ PATH: directory }) }), {
      runner: async () => ({ stdout: 'not json at all', stderr: '' })
    })
    const badJson = await malformed.execute('call-1', { python_modules: ['numpy'] })
    assert.equal(badJson.isError, undefined)
    assert.match(text(badJson), /python: Python probe failed: /)
    assert.match(text(badJson), /numpy: unchecked/)
    assert.equal(python, join(directory, 'python3'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the real Python probe reports a stdlib module when python3 exists', async (t) => {
  const python = await resolveCommand('python3', process.env.PATH)
  if (!python) {
    t.skip('python3 is not installed')
    return
  }
  const result = await probePython(python, ['json'], process.env, process.cwd(), defaultProbeRunner)
  assert.equal(result.checked, true)
  assert.equal(result.modules[0]?.name, 'json')
  assert.equal(result.modules[0]?.found, true)
  assert.ok(result.modules[0]?.version == null || typeof result.modules[0].version === 'string')
})
