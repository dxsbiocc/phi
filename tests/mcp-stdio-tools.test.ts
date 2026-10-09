import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { describeEnvironment } from '../src/main/agent/content'
import { currentPlatform } from '../src/main/agent/envs'
import { hasLiveEnvironmentLeases } from '../src/main/agent/envs/leases'
import { collectGarbage } from '../src/main/agent/envs/gc'
import { managedStdioServer } from '../src/main/agent/mcp'
import { findBunExecutable } from '../src/main/agent/omp/bun-executable'
import { OmpBridge } from '../src/main/agent/omp/omp-bridge'
import { copyMinimal, installReady, shQuote } from './helpers/fakeEnvironment'

const bunPath = findBunExecutable()
const REF = 'phi:python@1'
const SERVER = join(process.cwd(), 'tests/helpers/fixtureMcpServer.mjs')
const WORKER = join(process.cwd(), 'src/main/agent/omp/omp-sdk-worker.ts')
const SERVER_REQUEST_TIMEOUT_MS = 8_000
const FIXTURE_STARTUP_TIMEOUT_MS = 15_000
const FIXTURE_TEST_TIMEOUT_MS = 45_000

type ServerSnapshot = {
  pid: number
  args: string[]
  cwd: string
  env: Record<string, string>
  methods: string[]
}

async function fixture(
  mode: string,
  run: (value: {
    bridge: OmpBridge
    params: {
      name: string
      entry: ReturnType<typeof managedStdioServer>['entry'] & { timeout: number }
      environment: {
        root: string
        environmentsDir: string
        platform: ReturnType<typeof currentPlatform>
      }
    }
    snapshotPath: string
  }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-mcp-tool-probe-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  const environment = {
    root: join(process.env.PI_CODING_AGENT_DIR, 'runtime'),
    environmentsDir: join(root, 'environments'),
    platform: currentPlatform()
  }
  const snapshotPath = join(root, 'server.json')
  copyMinimal(join(environment.environmentsDir, 'phi-python'))
  installReady(environment.root, describeEnvironment(REF, environment), {
    'fixture-mcp': `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(SERVER)} "$@"\n`
  })
  const entry = managedStdioServer({
    ...environment,
    ref: REF,
    command: 'fixture-mcp',
    args: [snapshotPath, mode, 'a b; $(never-run)'],
    cwd: root
  }).entry
  const bridge = new OmpBridge(() =>
    spawn(bunPath!, [WORKER], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OMP_APP_NAME: 'Phi',
        PHI_PROBE_HOST_SENTINEL: 'must-not-reach-server',
        PYTHONPATH: '/host/python',
        CONDA_PREFIX: '/host/conda'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
  )
  try {
    await run({
      bridge,
      params: {
        name: 'fixture',
        entry: { ...entry, timeout: SERVER_REQUEST_TIMEOUT_MS },
        environment
      },
      snapshotPath
    })
  } finally {
    await bridge.stop()
    if (existsSync(snapshotPath)) {
      const { pid } = snapshot(snapshotPath)
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* Already cleaned up. */
      }
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
}

function snapshot(path: string): ServerSnapshot {
  return JSON.parse(readFileSync(path, 'utf8')) as ServerSnapshot
}

async function waitForServerMethod(path: string, method: string): Promise<ServerSnapshot> {
  const deadline = Date.now() + FIXTURE_STARTUP_TIMEOUT_MS
  while (true) {
    if (existsSync(path)) {
      const seen = snapshot(path)
      if (seen.methods.includes(method)) return seen
    }
    assert.ok(
      Date.now() < deadline,
      `MCP fixture did not receive ${method} within its startup budget`
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function assertDeadAtReturn(path: string): void {
  const { pid } = snapshot(path)
  try {
    process.kill(pid, 0)
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH')
    return
  }
  assert.fail(`MCP fixture ${pid} was still alive when the API returned`)
}

test(
  'configured stdio discovery uses the real worker and SDK, refreshes its managed launch, and disconnects',
  { skip: !bunPath, timeout: FIXTURE_TEST_TIMEOUT_MS },
  async () => {
    await fixture('success', async ({ bridge, params, snapshotPath }) => {
      // Never execute cached/stale wrapper arguments, even when the marker's envId is unchanged.
      params.entry.args = ['-i', '/usr/bin/false']
      assert.deepEqual(await bridge.request('mcp.configuredStdioTools', params), [
        'fixture_first',
        'fixture_second'
      ])
      const seen = snapshot(snapshotPath)
      assert.equal(seen.cwd, realpathSync(params.entry.cwd!))
      assert.deepEqual(seen.args, [snapshotPath, 'success', 'a b; $(never-run)'])
      assert.equal(seen.env.PHI_ENV_ID, params.entry.phiManaged.envId)
      assert.equal(seen.env.PHI_PROBE_HOST_SENTINEL, undefined)
      assert.equal(seen.env.PYTHONPATH, undefined)
      assert.equal(seen.env.CONDA_PREFIX, undefined)
      assert.deepEqual(seen.methods, [
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/list'
      ])
      assertDeadAtReturn(snapshotPath)
      assert.equal(
        hasLiveEnvironmentLeases(params.environment.root, params.entry.phiManaged.envId),
        false
      )
    })
  }
)

test(
  'persistent worker sessions retain managed MCP leases through discovery and release on disable or disposal',
  { skip: !bunPath, timeout: FIXTURE_TEST_TIMEOUT_MS },
  async () => {
    await fixture('success', async ({ bridge, params, snapshotPath }) => {
      const agentDir = dirname(params.environment.root)
      const profilePath = join(agentDir, 'mcp.json')
      writeFileSync(profilePath, JSON.stringify({ mcpServers: { fixture: params.entry } }))
      bridge.registerHostHandler('settings.nextActionSuggestionsEnabled', () => false)
      const session = await bridge.request<{ sessionId: string }>('session.create', {
        sessionId: 'lease-session',
        agentDir,
        cwd: params.entry.cwd,
        sessionManager: { kind: 'memory' },
        resourceOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true
        }
      })
      assert.equal(session.sessionId, 'lease-session')
      await waitForServerMethod(snapshotPath, 'tools/list')
      assert.equal(
        hasLiveEnvironmentLeases(params.environment.root, params.entry.phiManaged.envId),
        true
      )
      assert.deepEqual(collectGarbage(params.environment.root).skipped, [
        { envId: params.entry.phiManaged.envId, reason: 'in-use' }
      ])
      const upgradedEnvId = 'phi-upgrade-aaaaaaaaaaaa'
      writeFileSync(
        profilePath,
        JSON.stringify({
          mcpServers: {
            fixture: {
              ...params.entry,
              args: ['-i', '/usr/bin/false'],
              phiManaged: { ...params.entry.phiManaged, envId: upgradedEnvId }
            }
          }
        })
      )
      await bridge.request('mcp.applyConnectorEnabled', { name: 'fixture' })
      assert.equal(
        hasLiveEnvironmentLeases(params.environment.root, params.entry.phiManaged.envId),
        true
      )
      assert.equal(hasLiveEnvironmentLeases(params.environment.root, upgradedEnvId), false)
      writeFileSync(
        profilePath,
        JSON.stringify({ mcpServers: { fixture: { ...params.entry, enabled: false } } })
      )
      await bridge.request('mcp.applyConnectorEnabled', { name: 'fixture' })
      assertDeadAtReturn(snapshotPath)
      assert.equal(
        hasLiveEnvironmentLeases(params.environment.root, params.entry.phiManaged.envId),
        false
      )
      rmSync(snapshotPath)
      writeFileSync(profilePath, JSON.stringify({ mcpServers: { fixture: params.entry } }))
      await bridge.request('mcp.applyConnectorEnabled', { name: 'fixture' })
      await waitForServerMethod(snapshotPath, 'tools/list')
      assert.equal(snapshot(snapshotPath).cwd, realpathSync(params.entry.cwd!))
      assert.equal(
        hasLiveEnvironmentLeases(params.environment.root, params.entry.phiManaged.envId),
        true
      )
      await bridge.request('session.dispose', { sessionId: 'lease-session' })
      assertDeadAtReturn(snapshotPath)
      assert.equal(
        hasLiveEnvironmentLeases(params.environment.root, params.entry.phiManaged.envId),
        false
      )
    })
  }
)

test(
  'persistent worker creation failure releases already acquired managed leases before spawning',
  { skip: !bunPath, timeout: FIXTURE_TEST_TIMEOUT_MS },
  async () => {
    await fixture('success', async ({ bridge, params, snapshotPath }) => {
      const agentDir = dirname(params.environment.root)
      const invalid = {
        ...params.entry,
        args: [...params.entry.args, 'different-config'],
        phiManaged: { ...params.entry.phiManaged, envId: '../escape' }
      }
      writeFileSync(
        join(agentDir, 'mcp.json'),
        JSON.stringify({ mcpServers: { fixture: params.entry, 'zz-invalid-lease': invalid } })
      )
      await assert.rejects(
        bridge.request('session.create', {
          sessionId: 'lease-failed',
          agentDir,
          cwd: params.entry.cwd,
          sessionManager: { kind: 'memory' },
          resourceOptions: {
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true
          }
        }),
        /invalid environment lease envId/
      )
      assert.equal(
        hasLiveEnvironmentLeases(params.environment.root, params.entry.phiManaged.envId),
        false
      )
      assert.equal(existsSync(snapshotPath), false)
    })
  }
)

for (const mode of ['timeout', 'init-error', 'list-timeout', 'list-error']) {
  test(
    `persistent worker disposal drains managed ${mode} startup before releasing its lease`,
    { skip: !bunPath, timeout: FIXTURE_TEST_TIMEOUT_MS },
    async () => {
      await fixture(mode, async ({ bridge, params, snapshotPath }) => {
        const agentDir = dirname(params.environment.root)
        writeFileSync(
          join(agentDir, 'mcp.json'),
          JSON.stringify({ mcpServers: { fixture: params.entry } })
        )
        bridge.registerHostHandler('settings.nextActionSuggestionsEnabled', () => false)
        await bridge.request('session.create', {
          sessionId: 'lease-startup',
          agentDir,
          cwd: params.entry.cwd,
          sessionManager: { kind: 'memory' },
          resourceOptions: {
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true
          }
        })
        await waitForServerMethod(
          snapshotPath,
          mode === 'list-timeout' || mode === 'list-error' ? 'tools/list' : 'initialize'
        )
        assert.equal(
          hasLiveEnvironmentLeases(params.environment.root, params.entry.phiManaged.envId),
          true
        )
        await bridge.request('session.dispose', { sessionId: 'lease-startup' })
        assertDeadAtReturn(snapshotPath)
        assert.equal(
          hasLiveEnvironmentLeases(params.environment.root, params.entry.phiManaged.envId),
          false
        )
      })
    }
  )
  test(
    `configured stdio discovery cleans up a server after ${mode}`,
    { skip: !bunPath, timeout: FIXTURE_TEST_TIMEOUT_MS },
    async () => {
      await fixture(mode, async ({ bridge, params, snapshotPath }) => {
        const discovery = bridge.request('mcp.configuredStdioTools', params)
        // Observe cleanup protection while the real SDK transport is deliberately stalled.
        void discovery.catch(() => undefined)
        const seen = await waitForServerMethod(
          snapshotPath,
          mode === 'list-timeout' || mode === 'list-error' ? 'tools/list' : 'initialize'
        )
        // An explicit error may already have completed cleanup before the test is scheduled.
        // While the child is alive, its lease must still protect the prefix from collection.
        if (processAlive(seen.pid)) {
          assert.equal(
            hasLiveEnvironmentLeases(params.environment.root, params.entry.phiManaged.envId),
            true
          )
          assert.deepEqual(collectGarbage(params.environment.root).skipped, [
            { envId: params.entry.phiManaged.envId, reason: 'in-use' }
          ])
        }
        await assert.rejects(
          discovery,
          mode === 'list-error'
            ? /fixture tool-list failure/
            : mode === 'init-error'
              ? /fixture initialize failure|timeout|timed out/i
              : /timeout|timed out/i
        )
        assertDeadAtReturn(snapshotPath)
        assert.equal(
          hasLiveEnvironmentLeases(params.environment.root, params.entry.phiManaged.envId),
          false
        )
        assert.deepEqual(
          snapshot(snapshotPath).methods,
          mode === 'timeout' || mode === 'init-error'
            ? ['initialize']
            : ['initialize', 'notifications/initialized', 'tools/list']
        )
      })
    }
  )
}

test(
  'configured stdio discovery rejects unsupported, pending, or unavailable managed state before spawning',
  { skip: !bunPath, timeout: FIXTURE_TEST_TIMEOUT_MS },
  async () => {
    await fixture('success', async ({ bridge, params, snapshotPath }) => {
      await assert.rejects(
        bridge.request('mcp.configuredStdioTools', {
          ...params,
          entry: { type: 'http', url: 'https://example.org/mcp' }
        }),
        /stdio/i
      )
      await assert.rejects(
        bridge.request('mcp.configuredStdioTools', {
          ...params,
          entry: { command: process.execPath, args: [SERVER, snapshotPath, 'success'] }
        }),
        /managed/i
      )
      await assert.rejects(
        bridge.request('mcp.configuredStdioTools', {
          ...params,
          entry: { ...params.entry, phiManaged: { ...params.entry.phiManaged, pending: true } }
        }),
        /environment|环境/i
      )
      rmSync(join(params.environment.root, 'envs'), { recursive: true, force: true })
      await assert.rejects(
        bridge.request('mcp.configuredStdioTools', params),
        /ready|就绪|built|构建/i
      )
      assert.equal(existsSync(snapshotPath), false)
    })
  }
)
