import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { EnvironmentNotReadyError, describeEnvironment } from '../src/main/agent/content'
import { currentPlatform } from '../src/main/agent/envs'
import {
  McpCommandNotFoundError,
  managedStdioServer,
  readManagedMarker,
  refreshManagedStdioServers,
  resolveManagedEnvironment,
  type McpConfigLike
} from '../src/main/agent/mcp'
import { copyMinimal, installReady, shell } from './helpers/fakeEnvironment'

const REF = 'phi:python@1'
const SERVER = shell(['exec cat'])
const HOST_ENV: NodeJS.ProcessEnv = {
  HOME: '/Users/tester',
  LANG: 'en_US.UTF-8',
  PATH: '/opt/homebrew/bin:/usr/bin',
  PYTHONPATH: '/host/site',
  CONDA_PREFIX: '/host/conda',
  PHI_TEST_HOST_SENTINEL: 'leak'
}

interface Fixture {
  runtime: string
  environmentsDir: string
  project: string
  platform: ReturnType<typeof currentPlatform>
}

function withFixture(run: (fixture: Fixture) => void): void {
  const runtime = mkdtempSync(join(tmpdir(), 'phi-mcp-stdio-'))
  const project = mkdtempSync(join(tmpdir(), 'phi-mcp-project-'))
  try {
    const environmentsDir = join(runtime, 'environments')
    copyMinimal(join(environmentsDir, 'phi-python'))
    run({ runtime, environmentsDir, project, platform: currentPlatform() })
  } finally {
    rmSync(runtime, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
}

function installBase(fixture: Fixture, binaries: Record<string, string>): string {
  const descriptor = describeEnvironment(REF, {
    environmentsDir: fixture.environmentsDir,
    platform: fixture.platform
  })
  return installReady(fixture.runtime, descriptor, binaries)
}

function installProjectOverride(fixture: Fixture, binaries: Record<string, string>): string {
  copyMinimal(join(fixture.project, '.phi', 'environments', 'python-x1'), 'python-x1')
  writeFileSync(
    join(fixture.project, '.phi', 'environments.json'),
    `${JSON.stringify({ version: 1, overrides: { [REF]: 'project:python-x1' } })}\n`
  )
  const descriptor = describeEnvironment('project:python-x1', {
    environmentsDir: fixture.environmentsDir,
    platform: fixture.platform,
    projectDir: fixture.project
  })
  return installReady(fixture.runtime, descriptor, binaries)
}

/** Splits `/usr/bin/env -i K=V … <command> <args…>` back into its parts. */
function invocation(entry: { command: string; args: string[] }): {
  env: Record<string, string>
  command: string
  args: string[]
} {
  assert.equal(entry.command, '/usr/bin/env')
  assert.equal(entry.args[0], '-i')
  const env: Record<string, string> = {}
  let index = 1
  for (; index < entry.args.length; index += 1) {
    const arg = entry.args[index] ?? ''
    const eq = arg.indexOf('=')
    if (eq <= 0 || arg.startsWith('/')) break
    env[arg.slice(0, eq)] = arg.slice(eq + 1)
  }
  return { env, command: entry.args[index] ?? '', args: entry.args.slice(index + 1) }
}

function lookup(fixture: Fixture): {
  root: string
  environmentsDir: string
  platform: Fixture['platform']
} {
  return {
    root: fixture.runtime,
    environmentsDir: fixture.environmentsDir,
    platform: fixture.platform
  }
}

test('the command resolves inside the environment and runs under env -i with its args', () => {
  withFixture((fixture) => {
    const envId = installBase(fixture, { 'mcp-server': SERVER })
    const { entry, warnings } = managedStdioServer({
      ...lookup(fixture),
      ref: REF,
      command: 'mcp-server',
      args: ['--stdio', '--flag=a b'],
      cwd: fixture.project,
      baseEnv: HOST_ENV
    })
    const prefix = join(fixture.runtime, 'envs', envId)
    assert.deepEqual(warnings, [])
    assert.equal(entry.type, 'stdio')
    const call = invocation(entry)
    assert.equal(call.command, join(prefix, 'bin', 'mcp-server'))
    assert.deepEqual(call.args, ['--stdio', '--flag=a b'])
    assert.deepEqual(entry.env, {})
    assert.equal(entry.cwd, fixture.project)
    assert.deepEqual(entry.phiManaged, {
      version: 1,
      ref: REF,
      effectiveRef: REF,
      envId,
      command: 'mcp-server',
      args: ['--stdio', '--flag=a b']
    })
    assert.deepEqual(readManagedMarker(entry), entry.phiManaged)
    assert.equal(JSON.parse(JSON.stringify(entry)).phiManaged.envId, envId)
  })
})

test('a command missing from the environment fails with a clear error', () => {
  withFixture((fixture) => {
    const envId = installBase(fixture, { 'mcp-server': SERVER })
    assert.throws(
      () =>
        managedStdioServer({ ...lookup(fixture), ref: REF, command: 'nope', baseEnv: HOST_ENV }),
      (error: unknown) => {
        assert.ok(error instanceof McpCommandNotFoundError)
        assert.equal(error.message, `command not found in environment ${envId}: nope`)
        return true
      }
    )
  })
})

test('an environment that is not ready is a typed error with no host fallback', () => {
  withFixture((fixture) => {
    assert.throws(
      () => managedStdioServer({ ...lookup(fixture), ref: REF, command: 'cat', baseEnv: HOST_ENV }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentNotReadyError)
        assert.equal(error.ref, REF)
        return true
      }
    )
  })
})

test('env carries the isolation variables and the environment PATH, not host variables', () => {
  withFixture((fixture) => {
    const envId = installBase(fixture, { 'mcp-server': SERVER })
    const prefix = join(fixture.runtime, 'envs', envId)
    const { entry } = managedStdioServer({
      ...lookup(fixture),
      ref: REF,
      command: 'mcp-server',
      baseEnv: HOST_ENV
    })
    const env = invocation(entry).env
    assert.equal(env.PATH?.startsWith(`${join(prefix, 'bin')}:`), true)
    assert.equal(env.PATH?.includes('/opt/homebrew/bin'), false)
    assert.equal(env.PHI_ENV_ID, envId)
    assert.equal(env.PHI_ENV_PREFIX, prefix)
    assert.equal(env.PYTHONNOUSERSITE, '1')
    assert.equal(env.MPLBACKEND, 'Agg')
    assert.equal(env.R_PROFILE_USER, '/dev/null')
    assert.equal(env.HOME, '/Users/tester')
    assert.equal(env.PHI_TEST_HOST_SENTINEL, undefined)
    assert.equal(env.PYTHONPATH, undefined)
    assert.equal(env.CONDA_PREFIX, undefined)
  })
})

test('a project override selects the project environment', () => {
  withFixture((fixture) => {
    installBase(fixture, { 'mcp-server': SERVER })
    const projectEnvId = installProjectOverride(fixture, { 'mcp-server': SERVER })
    const { entry } = managedStdioServer({
      ...lookup(fixture),
      ref: REF,
      command: 'mcp-server',
      projectDir: fixture.project,
      baseEnv: HOST_ENV
    })
    const call = invocation(entry)
    assert.equal(call.command, join(fixture.runtime, 'envs', projectEnvId, 'bin', 'mcp-server'))
    assert.equal(call.env.PHI_ENV_ID, projectEnvId)
    assert.deepEqual(entry.phiManaged, {
      version: 1,
      ref: REF,
      effectiveRef: 'project:python-x1',
      envId: projectEnvId,
      command: 'mcp-server',
      args: [],
      projectDir: fixture.project
    })
  })
})

test('refresh regenerates only stale managed entries and leaves user entries untouched', () => {
  withFixture((fixture) => {
    const envId = installBase(fixture, { 'mcp-server': SERVER })
    const options = { ...lookup(fixture), ref: REF, command: 'mcp-server', baseEnv: HOST_ENV }
    const fresh = managedStdioServer({ ...options, args: ['--fresh'] }).entry
    const stale = {
      ...managedStdioServer({ ...options, args: ['--stale'] }).entry,
      args: ['-i', 'PATH=/old/envs/stale/bin', '/old/envs/stale/bin/mcp-server', '--stale'],
      enabled: false,
      timeout: 5000
    }
    stale.phiManaged = { ...stale.phiManaged, envId: 'stale' }
    const gone = {
      ...fresh,
      phiManaged: { ...fresh.phiManaged, ref: 'phi:missing@1', envId: 'gone' }
    }
    const userStdio = { command: 'uvx', args: ['mcp-server-git'], env: { TOKEN: 'x' } }
    const userHttp = { type: 'http', url: 'https://example.org/mcp', enabled: true }
    const malformed = { command: 'x', phiManaged: { version: 2, ref: REF } }
    const config: McpConfigLike = {
      settings: { keep: true },
      mcpServers: { fresh, stale, gone, userStdio, userHttp, malformed }
    }
    const snapshot = JSON.stringify(config)

    const result = refreshManagedStdioServers(
      config,
      (request) => resolveManagedEnvironment(request, lookup(fixture)),
      { baseEnv: HOST_ENV }
    )

    assert.equal(JSON.stringify(config), snapshot, 'input is not mutated')
    assert.notEqual(result.config, config)
    assert.deepEqual(result.refreshed, ['stale'])
    assert.deepEqual(
      result.failures.map((failure) => [failure.name, failure.ref]),
      [['gone', 'phi:missing@1']]
    )
    const servers = result.config.mcpServers ?? {}
    assert.deepEqual(result.config.settings, { keep: true })
    assert.equal(servers.userStdio, userStdio)
    assert.equal(servers.userHttp, userHttp)
    assert.equal(servers.malformed, malformed)
    assert.equal(servers.fresh, fresh)
    assert.equal(servers.gone, gone)
    const refreshed = servers.stale as typeof stale
    const call = invocation(refreshed)
    assert.equal(call.command, join(fixture.runtime, 'envs', envId, 'bin', 'mcp-server'))
    assert.deepEqual(call.args, ['--stale'])
    assert.equal(call.env.PHI_ENV_ID, envId)
    assert.equal(refreshed.phiManaged.envId, envId)
    assert.equal(refreshed.enabled, false)
    assert.equal(refreshed.timeout, 5000)
  })
})

test('refresh without mcpServers returns a copy', () => {
  const config: McpConfigLike = { other: 1 }
  const result = refreshManagedStdioServers(config, () => {
    throw new Error('not called')
  })
  assert.deepEqual(result.config, { other: 1 })
  assert.notEqual(result.config, config)
  assert.deepEqual(result.refreshed, [])
})

test('spawned the way omp does, the server sees no host variables', () => {
  withFixture((fixture) => {
    installBase(fixture, { 'mcp-server': shell(['exec /usr/bin/env']) })
    const { entry } = managedStdioServer({
      ...lookup(fixture),
      ref: REF,
      command: 'mcp-server',
      baseEnv: HOST_ENV
    })
    // omp: spawn(command, args, { env: { ...process.env, ...entry.env } })
    const result = spawnSync(entry.command, entry.args, {
      encoding: 'utf8',
      env: { ...process.env, ...HOST_ENV, ...entry.env }
    })
    assert.equal(result.status, 0, result.stderr)
    const seen = new Set(result.stdout.split('\n').map((line) => line.split('=')[0]))
    assert.equal(seen.has('PHI_TEST_HOST_SENTINEL'), false)
    assert.equal(seen.has('PYTHONPATH'), false)
    assert.equal(seen.has('CONDA_PREFIX'), false)
    assert.equal(seen.has('PHI_ENV_ID'), true)
    assert.equal(seen.has('HOME'), true)
  })
})
