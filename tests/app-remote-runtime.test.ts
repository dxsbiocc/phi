import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRemoteRuntimeDispatchControl,
  type RemoteRuntimeDispatchControlDeps
} from '../src/main/agent/remote-runtime/remote-runtime-dispatch-control'
import {
  createAppRemoteDesktopTools,
  type AppRemoteDesktopToolsDeps
} from '../src/main/agent/remote-runtime/app-remote-desktop-tools'

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function dispatchFixture(options: { child?: boolean } = {}): ReturnType<
  typeof createRemoteRuntimeDispatchControl
> & {
  request: { runtimeSessionId: string; remoteSessionId: string; projectId: string }
  replaceOrigin(): void
  replaceBinding(): void
  replaceRun(): void
  replaceOwner(): void
} {
  let origin = { phiSessionId: 'phi-1' }
  let binding = { cacheKey: 'binding-1' }
  let activeRun = { signal: new AbortController().signal }
  let owner = { toolOwner: 'Researcher', allowedSkills: ['analysis'] as readonly string[] }
  const deps: RemoteRuntimeDispatchControlDeps = {
    fields: { optionalStringField },
    sessions: {
      resolveOriginSession: () => origin,
      getActiveRun: () => activeRun,
      ownsRemoteRuntimeSession: () => options.child === true
    },
    workspace: { resolveBinding: () => binding },
    engine: { resourceOwner: () => owner }
  }
  return {
    ...createRemoteRuntimeDispatchControl(deps),
    request: {
      runtimeSessionId: 'runtime-1',
      remoteSessionId: 'phi-1',
      projectId: 'project-1'
    },
    replaceOrigin: () => {
      origin = { phiSessionId: 'phi-2' }
    },
    replaceBinding: () => {
      binding = { cacheKey: 'binding-2' }
    },
    replaceRun: () => {
      activeRun = { signal: new AbortController().signal }
    },
    replaceOwner: () => {
      owner = { toolOwner: 'Writer', allowedSkills: ['writing'] }
    }
  }
}

test('local requests bypass remote dispatch and cancellation without reading remote state', () => {
  const unavailable = (): never => {
    throw new Error('remote state should not be read')
  }
  const deps: RemoteRuntimeDispatchControlDeps = {
    fields: { optionalStringField },
    sessions: {
      resolveOriginSession: unavailable,
      getActiveRun: unavailable,
      ownsRemoteRuntimeSession: unavailable
    },
    workspace: { resolveBinding: unavailable },
    engine: { resourceOwner: unavailable }
  }
  const controls = createRemoteRuntimeDispatchControl(deps)
  const context = { originSessionId: 'runtime-local' }

  assert.equal(
    controls.remoteRuntimeDispatchControl({ runtimeSessionId: 'runtime-local' }, context),
    undefined
  )
  assert.equal(controls.isRemoteRuntimeCancellation(null, context), false)
})

test('remote-shaped requests reject incomplete or mismatched source identity', () => {
  const fixture = dispatchFixture()
  assert.throws(
    () =>
      fixture.remoteRuntimeDispatchControl(
        { remoteSessionId: 'phi-1', projectId: 'project-1' },
        { originSessionId: 'runtime-1' }
      ),
    /来源会话无效.*没有回退/
  )
  assert.throws(
    () =>
      fixture.remoteRuntimeDispatchControl(fixture.request, {
        originSessionId: 'runtime-other'
      }),
    /来源会话无效.*没有回退/
  )
  fixture.replaceOrigin()
  assert.throws(
    () => fixture.isRemoteRuntimeCancellation(fixture.request, { originSessionId: 'runtime-1' }),
    /取消请求的来源会话无效/
  )
})

for (const invalidation of [
  'context abort',
  'run replacement',
  'origin change',
  'binding change'
] as const)
  test(`parent remote dispatch rejects ${invalidation} after capture`, () => {
    const fixture = dispatchFixture()
    const contextController = new AbortController()
    const control = fixture.remoteRuntimeDispatchControl(fixture.request, {
      originSessionId: 'runtime-1',
      signal: contextController.signal
    })!
    control.beforeDispatch()
    if (invalidation === 'context abort') contextController.abort(new Error('stopped'))
    if (invalidation === 'run replacement') fixture.replaceRun()
    if (invalidation === 'origin change') fixture.replaceOrigin()
    if (invalidation === 'binding change') fixture.replaceBinding()
    assert.throws(() => control.beforeDispatch())
  })

test('remote child dispatch snapshots resource ownership and ignores the parent run', () => {
  const fixture = dispatchFixture({ child: true })
  const control = fixture.remoteRuntimeDispatchControl(fixture.request, {
    originSessionId: 'runtime-1',
    agentRunId: 'child-1',
    signal: new AbortController().signal
  })!
  assert.deepEqual(control.resourceOwner, {
    toolOwner: 'Researcher',
    allowedSkills: ['analysis']
  })
  assert.equal(Object.isFrozen(control.resourceOwner), true)
  assert.equal(Object.isFrozen(control.resourceOwner!.allowedSkills), true)
  fixture.replaceRun()
  control.beforeDispatch()
  fixture.replaceOwner()
  assert.throws(() => control.beforeDispatch(), /运行身份已改变/)
})

test('remote cancellation validates the runtime owner but not the project field', () => {
  const fixture = dispatchFixture()
  assert.equal(
    fixture.isRemoteRuntimeCancellation(
      { ...fixture.request, projectId: 'different-project' },
      { originSessionId: 'runtime-1' }
    ),
    true
  )
})

function desktopFixture(): {
  deps: AppRemoteDesktopToolsDeps
  calls: string[]
  skipped: Array<{ sessionId: string; notices: readonly unknown[] }>
  search: { retire(): void; close(): Promise<void>; tool: { name: string } }
  mcp: {
    retire(): void
    close(): Promise<void>
    tools: never[]
    skipped: Array<{ name: string; reason: string }>
  }
  memoryAdapter: { retire(): void; close(): Promise<void> }
  setMemory(value: { enabled: boolean; learn: boolean }): void
  setBinding(value: string): void
} {
  const calls: string[] = []
  let memory = { enabled: false, learn: false }
  let binding = 'binding-1'
  const skipped: Array<{ sessionId: string; notices: readonly unknown[] }> = []
  const search = {
    retire: () => {
      calls.push('search.retire')
    },
    close: async () => {
      calls.push('search.close')
    },
    tool: { name: 'web_search' }
  }
  const mcp = {
    retire: () => {
      calls.push('mcp.retire')
    },
    close: async () => {
      calls.push('mcp.close')
    },
    tools: [],
    skipped: [{ name: 'unavailable', reason: 'unavailable' }]
  }
  const memoryAdapter = {
    retire: () => {
      calls.push('memory.retire')
    },
    close: async () => {
      calls.push('memory.close')
    }
  }
  const deps: AppRemoteDesktopToolsDeps = {
    agentDir: '/agent',
    sessions: {
      findById: () => ({
        cwd: '/anchor',
        model: { providerId: 'openai', modelId: 'gpt-test' }
      })
    },
    projects: { getById: () => ({ memory }) },
    workspace: { resolveBinding: () => ({ cacheKey: binding }) },
    catalogs: {
      listGlobalSkills: async () =>
        [
          { name: 'project-skill', description: 'shadowed', enabled: true },
          { name: 'global-skill', description: 'global', enabled: true },
          { name: 'disabled-skill', description: 'disabled', enabled: false }
        ] as never,
      loadProjectSkills: async () =>
        ({
          summaries: [{ name: 'project-skill', description: 'project' }],
          sources: [{ name: 'project-skill' }]
        }) as never,
      listGlobalMcpServers: async () => [],
      loadProjectMcp: async () => ({ summaries: [], runtimeServers: [] })
    },
    runtime: {
      scriptTools: async () => ({ tools: [{ name: 'project_script' }], problems: [] }) as never,
      approvalFor: () => 'read',
      dispatchControl: () => ({ beforeDispatch: () => {} })
    },
    adapters: {
      createWebSearch: async () => search as never,
      createMcp: async () => mcp as never,
      createMemory: async () => memoryAdapter as never
    },
    skippedMcp: {
      notify: (sessionId, notices) => skipped.push({ sessionId, notices })
    }
  }
  return {
    deps,
    calls,
    skipped,
    search,
    mcp,
    memoryAdapter,
    setMemory: (value: typeof memory) => {
      memory = value
    },
    setBinding: (value: string) => {
      binding = value
    }
  }
}

const desktopIdentity = {
  runtimeSessionId: 'runtime-1',
  sessionId: 'phi-1',
  projectId: 'project-1',
  cwd: '/remote/project',
  resourceCwd: '/anchor'
}

test('desktop tools merge selected skills and skip disabled memory and empty MCP', async () => {
  const fixture = desktopFixture()
  const resources = await createAppRemoteDesktopTools(fixture.deps)(
    desktopIdentity,
    new AbortController().signal
  )

  assert.deepEqual(resources.tools.allowedSkills, ['project-skill', 'global-skill'])
  assert.deepEqual(resources.tools.skillCatalog, [
    { name: 'project-skill', description: 'project' },
    { name: 'global-skill', description: 'global' }
  ])
  assert.equal(resources.tools.desktopWebSearch, fixture.search)
  assert.equal(resources.tools.desktopMcp, undefined)
  assert.equal(resources.memory, undefined)
  assert.deepEqual(fixture.skipped, [{ sessionId: 'phi-1', notices: [] }])

  fixture.calls.length = 0
  await resources.close?.()
  assert.deepEqual(fixture.calls, ['search.retire', 'search.close'])
})

test('desktop tools preserve memory, MCP, child approval and cleanup branches', async () => {
  const fixture = desktopFixture()
  fixture.setMemory({ enabled: true, learn: true })
  fixture.deps.catalogs.listGlobalMcpServers = async () =>
    [
      { name: 'shared', enabled: true },
      { name: 'disabled', enabled: false }
    ] as never
  fixture.deps.catalogs.loadProjectMcp = async () =>
    ({
      summaries: [],
      runtimeServers: [{ name: 'shared' }, { name: 'remote' }]
    }) as never
  let searchOptions:
    Parameters<AppRemoteDesktopToolsDeps['adapters']['createWebSearch']>[0] | undefined
  let memoryOptions:
    Parameters<AppRemoteDesktopToolsDeps['adapters']['createMemory']>[0] | undefined
  let mcpOptions: Parameters<AppRemoteDesktopToolsDeps['adapters']['createMcp']>[0] | undefined
  fixture.deps.adapters.createWebSearch = async (options) => {
    searchOptions = options
    return fixture.search as never
  }
  fixture.deps.adapters.createMemory = async (options) => {
    memoryOptions = options
    return fixture.memoryAdapter as never
  }
  fixture.deps.adapters.createMcp = async (options) => {
    mcpOptions = options
    return fixture.mcp as never
  }
  const dispatches: Array<{ params: unknown; context: unknown }> = []
  const childControl = { beforeDispatch: () => {} }
  fixture.deps.runtime.dispatchControl = (params, context) => {
    dispatches.push({ params, context })
    return childControl
  }
  const approvals: Array<{ name: string; input: unknown; control: unknown }> = []
  fixture.deps.runtime.approvalFor = (name, input, control) => {
    approvals.push({ name, input, control })
    return 'write'
  }
  const signal = new AbortController().signal
  const resources = await createAppRemoteDesktopTools(fixture.deps)(desktopIdentity, signal)

  assert.equal(resources.memory, fixture.memoryAdapter)
  assert.equal(resources.tools.desktopMcp, fixture.mcp)
  assert.equal(searchOptions?.agentDir, '/agent')
  assert.equal(searchOptions?.resourceCwd, '/anchor')
  assert.deepEqual(searchOptions?.identity, {
    runtimeSessionId: 'runtime-1',
    sessionId: 'phi-1',
    projectId: 'project-1',
    cwd: '/remote/project'
  })
  assert.deepEqual(memoryOptions?.settings, { enabled: true, learn: true })
  assert.equal(typeof memoryOptions?.beforeDispatch, 'function')
  assert.deepEqual(mcpOptions?.serverNames, ['shared', 'remote'])
  assert.deepEqual(mcpOptions?.remoteProjectMcpServers, [{ name: 'shared' }, { name: 'remote' }])
  assert.equal(mcpOptions?.approvalFor('anything', {}), 'write')
  assert.deepEqual(fixture.skipped, [
    { sessionId: 'phi-1', notices: [{ name: 'unavailable', reason: 'unavailable' }] }
  ])

  const scriptApprovalFor = resources.tools.scriptApprovalFor
  assert.ok(scriptApprovalFor)
  assert.equal(scriptApprovalFor('project_script', { value: 1 }), 'write')
  assert.equal(dispatches.length, 0)
  assert.equal(scriptApprovalFor('project_script', { value: 2 }, 'child-1'), 'write')
  assert.deepEqual(dispatches, [
    {
      params: {
        runtimeSessionId: 'runtime-1',
        remoteSessionId: 'phi-1',
        projectId: 'project-1'
      },
      context: {
        originSessionId: 'runtime-1',
        agentRunId: 'child-1',
        signal
      }
    }
  ])
  assert.deepEqual(approvals, [
    { name: 'project_script', input: { value: 1 }, control: undefined },
    { name: 'project_script', input: { value: 2 }, control: childControl }
  ])

  fixture.setMemory({ enabled: false, learn: false })
  assert.throws(() => memoryOptions?.beforeDispatch?.(), /记忆策略已改变/)
  fixture.setMemory({ enabled: true, learn: true })
  fixture.setBinding('binding-2')
  assert.throws(() => mcpOptions?.beforeDispatch?.(), /项目绑定已改变/)

  fixture.calls.length = 0
  await resources.close?.()
  assert.deepEqual(fixture.calls, [
    'search.retire',
    'mcp.retire',
    'memory.retire',
    'search.close',
    'mcp.close',
    'memory.close'
  ])
})

test('desktop tool construction retires partial adapters and preserves the original failure', async () => {
  const fixture = desktopFixture()
  fixture.setMemory({ enabled: true, learn: true })
  fixture.deps.catalogs.listGlobalMcpServers = async () =>
    [{ name: 'configured', enabled: true }] as never
  const failure = new Error('MCP construction failed')
  fixture.deps.adapters.createMcp = async () => {
    throw failure
  }
  fixture.memoryAdapter.close = async () => {
    fixture.calls.push('memory.close')
    throw new Error('secondary close failure')
  }

  await assert.rejects(
    createAppRemoteDesktopTools(fixture.deps)(desktopIdentity, new AbortController().signal),
    (error) => error === failure
  )
  assert.deepEqual(fixture.calls, [
    'search.retire',
    'memory.retire',
    'search.close',
    'memory.close'
  ])
})

for (const checkpoint of ['catalogs', 'scripts'] as const)
  test(`desktop tools recheck the binding after loading ${checkpoint}`, async () => {
    const fixture = desktopFixture()
    const gate = deferred<void>()
    let scriptsStarted = false
    let searchStarted = false
    if (checkpoint === 'catalogs') {
      fixture.deps.catalogs.loadProjectMcp = async () => {
        await gate.promise
        return { summaries: [], runtimeServers: [] }
      }
    } else {
      fixture.deps.runtime.scriptTools = async () => {
        scriptsStarted = true
        await gate.promise
        return { tools: [] }
      }
    }
    fixture.deps.adapters.createWebSearch = async () => {
      searchStarted = true
      return fixture.search as never
    }
    const loading = createAppRemoteDesktopTools(fixture.deps)(
      desktopIdentity,
      new AbortController().signal
    )
    const rejected = assert.rejects(loading, /项目绑定已改变/)
    await new Promise<void>((resolve) => setImmediate(resolve))
    fixture.setBinding('binding-2')
    gate.resolve()
    await rejected
    assert.equal(searchStarted, false)
    assert.equal(scriptsStarted, checkpoint === 'scripts')
  })
