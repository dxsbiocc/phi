import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import {
  ConnectorSetupTracker,
  type ConnectorSetupReporter
} from '../src/main/agent/mcp/connector-setup'
import type {
  FeaturedMcpConnector,
  McpConnectorSetupProgress
} from '../src/shared/mcpConnectorCatalog'

const AGENT_DIR = mkdtempSync(join(tmpdir(), 'phi-mcp-ipc-state-'))
test.after(() => rmSync(AGENT_DIR, { recursive: true, force: true }))
const RUNTIME_ROOT = '/verified/managed-runtime'
const REGISTRY_DIR = '/verified/official-registry'
const IPC_CHANNELS = [
  'mcp:listConnectorCatalog',
  'mcp:installConnector',
  'mcp:uninstallConnector',
  'mcp:buildConnectorEnvironment',
  'mcp:featuredTools'
]
type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

function extractedMainIpc(dependencies: Record<string, unknown>): Map<string, IpcHandler> {
  const source = ts.createSourceFile(
    'main.ts',
    readFileSync(resolve('src/main/index.ts'), 'utf8'),
    ts.ScriptTarget.ES2022,
    true
  )
  const definitions = new Map<string, ts.Statement>()
  const registrations = new Map<string, ts.ExpressionStatement>()
  const names = [
    'connectorSetups',
    'connectorCatalog',
    'prepareStdioEnvironment',
    'probeStdioTools'
  ]
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && names.includes(declaration.name.text))
          definitions.set(declaration.name.text, node)
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text))
      definitions.set(node.name.text, node)
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression
      const channel = call.arguments[0]
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.expression.getText(source) === 'ipcMain' &&
        call.expression.name.text === 'handle' &&
        channel &&
        ts.isStringLiteral(channel) &&
        IPC_CHANNELS.includes(channel.text)
      )
        registrations.set(channel.text, node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.deepEqual(
    [...definitions.keys()].sort(),
    names.toSorted(),
    'extract the actual main-process setup helpers'
  )
  assert.deepEqual(
    [...registrations.keys()].sort(),
    IPC_CHANNELS.toSorted(),
    'extract every exercised IPC registration'
  )
  const program = `const { ConnectorSetupTracker, sendToAllWindows, listConnectorCatalog, AGENT_DIR, app, getRuntimeRoot, loadPackageRegistries, connectorEnvironmentBuildAction, environmentBuilds, refreshPersistedManagedStdioServers, readMcpServerEntry, getOmpBridge, installCatalogConnector, uninstallCatalogConnector, officialContentSourceOptions, setEnabled, setMcpPackageEnabled, invalidateAgentSession } = dependencies;
  const join = (...parts) => parts.join('/');
  const callbacks = new Map();
  const ipcMain = { handle: (channel, callback) => callbacks.set(channel, callback) };
  ${names.map((name) => definitions.get(name)!.getText(source)).join('\n')}
  ${IPC_CHANNELS.map((channel) => registrations.get(channel)!.getText(source)).join('\n')}
  return callbacks;`
  const compiled = ts.transpileModule(program, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Function('dependencies', compiled)(dependencies) as Map<string, IpcHandler>
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let finish!: () => void
  const promise = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { promise, resolve: finish }
}

function harness(installed = true): {
  state: {
    installed: boolean
    entry: Record<string, unknown> | undefined
    buildError?: Error
    refreshError?: Error
    probeError?: Error
    invalidateError?: Error
    probeGate?: Promise<void>
    invalidateGate?: Promise<void>
  }
  calls: string[]
  progress: McpConnectorSetupProgress[]
  requests: { method: string; params: Record<string, unknown> }[]
  probeStarted: ReturnType<typeof deferred>
  invalidationStarted: ReturnType<typeof deferred>
  installResult: { id: string; version: string }[]
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  snapshot: () => Promise<McpConnectorSetupProgress | undefined>
} {
  rmSync(join(AGENT_DIR, 'state'), { recursive: true, force: true })
  const calls: string[] = []
  const progress: McpConnectorSetupProgress[] = []
  const requests: { method: string; params: Record<string, unknown> }[] = []
  const probeStarted = deferred()
  const invalidationStarted = deferred()
  const state: ReturnType<typeof harness>['state'] = {
    installed,
    entry: {
      type: 'stdio',
      command: '/usr/bin/env',
      args: ['-i', '/verified/environment/bin/server'],
      phiPackage: 'local',
      phiManaged: {
        version: 1,
        ref: 'phi:python@1',
        effectiveRef: 'phi:python@1',
        envId: 'ready-env',
        command: 'server',
        args: []
      }
    }
  }
  const installResult = [{ id: 'local', version: '1.0.0' }]
  const local: FeaturedMcpConnector = {
    id: 'local',
    version: '1.0.0',
    name: 'Local fixture',
    description: 'fixture',
    publisher: 'Phi tests',
    category: '科研数据',
    signIn: '本地服务',
    transport: 'stdio',
    registryDir: REGISTRY_DIR,
    added: installed
  }
  const http: FeaturedMcpConnector = {
    ...local,
    id: 'remote',
    name: 'HTTP fixture',
    transport: 'http',
    auth: 'oauth',
    url: 'https://http.example.test/mcp'
  }
  const action = { descriptor: { ref: './environment.yml' }, options: { packageId: 'local' } }
  const callbacks = extractedMainIpc({
    AGENT_DIR,
    ConnectorSetupTracker,
    app: { getVersion: () => '1.0.0' },
    getRuntimeRoot: () => RUNTIME_ROOT,
    loadPackageRegistries: async () => ({ registries: ['verified-index'] }),
    listConnectorCatalog: (options: unknown) => {
      assert.deepEqual(options, {
        agentDir: AGENT_DIR,
        appVersion: '1.0.0',
        runtimeRoot: RUNTIME_ROOT,
        registries: ['verified-index']
      })
      return [{ ...local, added: state.installed }, http]
    },
    sendToAllWindows: (channel: string, event: McpConnectorSetupProgress) => {
      assert.equal(channel, 'mcp:connectorSetupChanged')
      progress.push(event)
      calls.push(`phase:${event.phase}`)
    },
    readMcpServerEntry: (id: string, agentDir: string) => {
      if (id === 'remote') return undefined
      assert.equal(id, 'local')
      assert.equal(agentDir, AGENT_DIR)
      calls.push('entry:read')
      return state.installed ? state.entry : undefined
    },
    connectorEnvironmentBuildAction: (id: string, options: unknown) => {
      assert.equal(id, 'local')
      assert.deepEqual(options, { agentDir: AGENT_DIR })
      calls.push('environment:action')
      if (!state.installed) throw new Error('fixture connector is not installed')
      return action
    },
    environmentBuilds: {
      start: async (descriptor: unknown, options: unknown) => {
        assert.equal(descriptor, action.descriptor)
        assert.equal(options, action.options)
        calls.push('environment:build')
        if (state.buildError) throw state.buildError
        return { envId: 'ready-env' }
      }
    },
    refreshPersistedManagedStdioServers: (options: unknown) => {
      assert.deepEqual(options, { agentDir: AGENT_DIR, runtimeRoot: RUNTIME_ROOT })
      calls.push('environment:refresh')
      return { failures: state.refreshError ? [{ name: 'local', error: state.refreshError }] : [] }
    },
    officialContentSourceOptions: () => ({
      agentDir: AGENT_DIR,
      appVersion: '1.0.0',
      source: 'verified-official-source'
    }),
    installCatalogConnector: async (
      source: string,
      id: string,
      version: string,
      options: {
        agentDir: string
        appVersion: string
        source: string
        runtimeRoot: string
        onPhase: ConnectorSetupReporter
      }
    ) => {
      assert.equal(source, REGISTRY_DIR)
      assert.equal(version, '1.0.0')
      assert.equal(options.agentDir, AGENT_DIR)
      assert.equal(options.source, 'verified-official-source')
      assert.equal(options.runtimeRoot, RUNTIME_ROOT)
      calls.push('package:retrieve')
      options.onPhase('downloading')
      await Promise.resolve()
      calls.push('package:install')
      options.onPhase('installing')
      state.installed = true
      return id === 'local' ? installResult : [{ id, version }]
    },
    uninstallCatalogConnector: (id: string, options: unknown) => {
      assert.equal(id, 'local')
      assert.deepEqual(options, { agentDir: AGENT_DIR, runtimeRoot: RUNTIME_ROOT })
      calls.push('package:uninstall')
      state.installed = false
      return []
    },
    setEnabled: (key: string, value: boolean | null, options: unknown) => {
      assert.ok(['mcp:local', 'mcp:remote'].includes(key))
      assert.equal(value, state.installed ? true : null)
      assert.deepEqual(options, { agentDir: AGENT_DIR })
      calls.push('enablement:global')
    },
    setMcpPackageEnabled: (id: string, value: boolean, agentDir: string) => {
      assert.ok(['local', 'remote'].includes(id))
      assert.equal(value, true)
      assert.equal(agentDir, AGENT_DIR)
      calls.push('enablement:package')
    },
    getOmpBridge: () => ({
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params })
        calls.push(`worker:${method}`)
        if (method === 'mcp.configuredStdioTools') {
          probeStarted.resolve()
          await state.probeGate
          if (state.probeError) throw state.probeError
        }
        return ['fixture_first', 'fixture_second']
      }
    }),
    invalidateAgentSession: async () => {
      calls.push('invalidate:start')
      invalidationStarted.resolve()
      await state.invalidateGate
      if (state.invalidateError) throw state.invalidateError
      calls.push('invalidate:done')
    }
  })
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const callback = callbacks.get(channel)
    assert.ok(callback, `missing ${channel} callback`)
    return callback(null, ...args)
  }
  return {
    state,
    calls,
    progress,
    requests,
    probeStarted,
    invalidationStarted,
    installResult,
    invoke,
    snapshot: async () => {
      const catalog = (await invoke('mcp:listConnectorCatalog')) as FeaturedMcpConnector[]
      return catalog.find(({ id }) => id === 'local')?.setup
    }
  }
}

test('installed stdio discovery uses main-owned metadata and preserves active sessions', async () => {
  const f = harness()
  assert.deepEqual(await f.invoke('mcp:featuredTools', 'local', { command: 'renderer-command' }), [
    'fixture_first',
    'fixture_second'
  ])
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.requests[0], {
    method: 'mcp.configuredStdioTools',
    params: {
      name: 'local',
      entry: f.state.entry,
      environment: { agentDir: AGENT_DIR, root: RUNTIME_ROOT }
    }
  })
  assert.equal(f.requests[0].params.entry, f.state.entry)
  assert.deepEqual(
    f.progress.map(({ phase }) => phase),
    ['starting', 'ready']
  )
  assert.equal(
    f.calls.some((call) => /^(package:|environment:|enablement:|invalidate:)/.test(call)),
    false
  )
  assert.deepEqual((await f.snapshot())?.toolNames, ['fixture_first', 'fixture_second'])
})

test('read-only discovery failure records starting failure and permits retry without invalidating active sessions', async () => {
  const f = harness()
  f.state.probeError = new Error('fixture discovery failed')
  await assert.rejects(f.invoke('mcp:featuredTools', 'local'), /fixture discovery failed/)
  const failure = await f.snapshot()
  assert.deepEqual(
    f.progress.map(({ phase }) => phase),
    ['starting', 'failed']
  )
  assert.equal(failure?.failedPhase, 'starting')
  assert.equal(failure?.error, 'fixture discovery failed')
  assert.equal(f.state.installed, true)
  f.state.probeError = undefined
  await f.invoke('mcp:featuredTools', 'local')
  const retry = await f.snapshot()
  assert.equal(retry?.phase, 'ready')
  assert.equal(retry?.error, undefined)
  assert.ok((retry?.revision ?? 0) > (failure?.revision ?? 0))
  assert.equal(
    f.calls.some((call) => /^(package:|environment:|enablement:|invalidate:)/.test(call)),
    false
  )
})

test('HTTP featured tools preserve the existing auth request without starting a local server', async () => {
  const f = harness()
  await f.invoke('mcp:featuredTools', 'remote')
  assert.deepEqual(f.requests, [
    {
      method: 'mcp.featuredTools',
      params: { id: 'remote', url: 'https://http.example.test/mcp', auth: 'oauth' }
    }
  ])
  assert.deepEqual(f.progress, [])
  assert.equal(f.calls.includes('entry:read'), false)
  assert.equal(f.calls.includes('environment:build'), false)
})

test('uninstalled, foreign, and non-package stdio entries reject before launching a worker', async () => {
  const f = harness(false)
  await assert.rejects(f.invoke('mcp:featuredTools', 'local'), /先安装/)
  f.state.installed = true
  for (const entry of [
    { command: 'user-server' },
    { command: 'another-package', phiPackage: 'foreign' },
    undefined
  ]) {
    f.state.entry = entry
    await assert.rejects(f.invoke('mcp:featuredTools', 'local'), /先安装/)
  }
  await assert.rejects(
    f.invoke('mcp:featuredTools', { id: 'local', command: 'renderer-command' }),
    /标识无效/
  )
  await assert.rejects(f.invoke('mcp:featuredTools', 'missing'), /目录中找不到/)
  assert.equal(f.requests.length, 0)
  assert.equal(f.calls.includes('environment:build'), false)
})

test(
  'stdio installation exposes actual stages, rejects concurrent probing, and waits for discovery plus invalidation before readiness',
  { timeout: 5000 },
  async () => {
    const f = harness(false)
    const probe = deferred()
    const invalidation = deferred()
    f.state.probeGate = probe.promise
    f.state.invalidateGate = invalidation.promise
    const installation = f.invoke('mcp:installConnector', 'local', '1.0.0', REGISTRY_DIR)
    await f.probeStarted.promise
    assert.deepEqual(
      f.progress.map(({ phase }) => phase),
      ['downloading', 'installing', 'environment', 'starting']
    )
    assert.equal((await f.snapshot())?.phase, 'starting')
    await assert.rejects(f.invoke('mcp:featuredTools', 'local'), /进行中/)
    await assert.rejects(f.invoke('mcp:uninstallConnector', 'local'), /进行中/)
    assert.equal(f.calls.includes('package:uninstall'), false)
    assert.equal(f.state.installed, true)
    assert.equal(f.requests.filter(({ method }) => method === 'mcp.configuredStdioTools').length, 1)
    await f.invoke('mcp:featuredTools', 'remote')
    probe.resolve()
    await f.invalidationStarted.promise
    assert.equal(
      (await f.snapshot())?.phase,
      'starting',
      'ready waits for session invalidation to finish'
    )
    invalidation.resolve()
    assert.equal(await installation, f.installResult)
    assert.deepEqual(
      f.progress.map(({ phase }) => phase),
      ['downloading', 'installing', 'environment', 'starting', 'ready']
    )
    assert.ok(f.calls.indexOf('package:install') < f.calls.indexOf('environment:build'))
    assert.ok(
      f.calls.indexOf('environment:refresh') < f.calls.indexOf('worker:mcp.configuredStdioTools')
    )
    assert.ok(f.calls.indexOf('invalidate:done') < f.calls.indexOf('phase:ready'))
    assert.equal(f.state.installed, true)
  }
)

test('HTTP install finishes as installed after invalidation without preparing or probing a local environment', async () => {
  const f = harness(false)
  await f.invoke('mcp:installConnector', 'remote')
  assert.deepEqual(
    f.progress.map(({ phase }) => phase),
    ['downloading', 'installing', 'installed']
  )
  assert.ok(f.calls.indexOf('invalidate:done') < f.calls.indexOf('phase:installed'))
  assert.equal(f.calls.includes('environment:build'), false)
  assert.equal(f.requests.length, 0)
})

test(
  'uninstall publishes removed after invalidation and clears retained readiness for catalog reopen',
  { timeout: 5000 },
  async () => {
    const f = harness()
    await f.invoke('mcp:featuredTools', 'local')
    const previous = (await f.snapshot())!
    assert.deepEqual(previous.toolNames, ['fixture_first', 'fixture_second'])
    const invalidation = deferred()
    f.state.invalidateGate = invalidation.promise
    const removing = f.invoke('mcp:uninstallConnector', 'local')
    try {
      await f.invalidationStarted.promise
      assert.equal(f.state.installed, false)
      assert.equal(
        f.progress.some(({ phase }) => phase === 'removed'),
        false
      )
    } finally {
      invalidation.resolve()
    }
    assert.deepEqual(await removing, [])
    const removed = (await f.snapshot())!
    assert.equal(removed.phase, 'removed')
    assert.ok(removed.revision > previous.revision)
    assert.equal(removed.toolNames, undefined)
    assert.equal(removed.error, undefined)
    assert.equal(removed.failedPhase, undefined)
    assert.ok(f.calls.indexOf('package:uninstall') < f.calls.indexOf('invalidate:done'))
    assert.ok(f.calls.indexOf('invalidate:done') < f.calls.indexOf('phase:removed'))
    const catalog = (await f.invoke('mcp:listConnectorCatalog')) as FeaturedMcpConnector[]
    assert.equal(catalog.find(({ id }) => id === 'local')?.added, false)
  }
)

test('startup failure retains the installed package, invalidates before failure publication, and permits a probe retry', async () => {
  const f = harness(false)
  f.state.probeError = new Error('fixture startup failed')
  await assert.rejects(f.invoke('mcp:installConnector', 'local'), /fixture startup failed/)
  const failure = await f.snapshot()
  assert.equal(f.state.installed, true)
  assert.equal(failure?.phase, 'failed')
  assert.equal(failure?.failedPhase, 'starting')
  assert.equal(failure?.error, 'fixture startup failed')
  assert.ok(f.calls.indexOf('invalidate:done') < f.calls.indexOf('phase:failed'))
  f.state.probeError = undefined
  await f.invoke('mcp:featuredTools', 'local')
  const retry = await f.snapshot()
  assert.equal(retry?.phase, 'ready')
  assert.equal(retry?.error, undefined)
  assert.ok((retry?.revision ?? 0) > (failure?.revision ?? 0))
  assert.equal(f.calls.filter((call) => call === 'package:install').length, 1)
})

for (const failedStep of ['buildError', 'refreshError'] as const) {
  test(`environment ${failedStep} preserves installation and an environment-build retry performs discovery`, async () => {
    const f = harness(false)
    f.state[failedStep] = new Error(`fixture ${failedStep}`)
    await assert.rejects(
      f.invoke('mcp:installConnector', 'local'),
      new RegExp(`fixture ${failedStep}`)
    )
    const failure = await f.snapshot()
    assert.equal(f.state.installed, true)
    assert.equal(failure?.phase, 'failed')
    assert.equal(failure?.failedPhase, 'environment')
    assert.equal(f.requests.length, 0)
    assert.ok(f.calls.indexOf('invalidate:done') < f.calls.indexOf('phase:failed'))
    f.state[failedStep] = undefined
    assert.deepEqual(await f.invoke('mcp:buildConnectorEnvironment', 'local'), {
      envId: 'ready-env'
    })
    assert.equal(f.requests.at(-1)?.method, 'mcp.configuredStdioTools')
    assert.equal((await f.snapshot())?.phase, 'ready')
    assert.deepEqual(
      f.progress.slice(-3).map(({ phase }) => phase),
      ['environment', 'starting', 'ready']
    )
    assert.equal(f.calls.filter((call) => call === 'package:install').length, 1)
    assert.ok(f.calls.lastIndexOf('invalidate:done') < f.calls.lastIndexOf('phase:ready'))
  })
}

for (const failedStep of ['buildError', 'refreshError'] as const) {
  test(`failed explicit environment ${failedStep} invalidates the session before probing and permits retry`, async () => {
    const f = harness()
    f.state[failedStep] = new Error('fixture preparation failed')
    await assert.rejects(
      f.invoke('mcp:buildConnectorEnvironment', 'local'),
      /fixture preparation failed/
    )
    assert.equal((await f.snapshot())?.failedPhase, 'environment')
    assert.equal(f.state.installed, true)
    assert.equal(f.requests.length, 0)
    assert.equal(f.calls.filter((call) => call === 'invalidate:done').length, 1)
    f.state[failedStep] = undefined
    await f.invoke('mcp:buildConnectorEnvironment', 'local')
    assert.equal((await f.snapshot())?.phase, 'ready')
  })
}

test('session invalidation failure cannot publish readiness and can be retried without reinstalling', async () => {
  const f = harness(false)
  f.state.invalidateError = new Error('fixture invalidation failed')
  await assert.rejects(f.invoke('mcp:installConnector', 'local'), /fixture invalidation failed/)
  assert.equal((await f.snapshot())?.phase, 'failed')
  assert.equal(
    f.progress.some(({ phase }) => phase === 'ready'),
    false
  )
  assert.equal(f.state.installed, true)
  f.state.invalidateError = undefined
  await f.invoke('mcp:buildConnectorEnvironment', 'local')
  assert.equal((await f.snapshot())?.phase, 'ready')
  assert.equal(f.calls.filter((call) => call === 'package:install').length, 1)
})
