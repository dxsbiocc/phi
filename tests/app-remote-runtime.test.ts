import assert from 'node:assert/strict'
import test from 'node:test'

import type { DesktopMcpOptions } from '../src/main/agent/engine/rpc/desktop-mcp-types'
import {
  createAppRemoteDesktopTools,
  type AppRemoteDesktopToolsDeps
} from '../src/main/agent/remote-runtime/app-remote-desktop-tools'
import {
  createRemoteRuntimeDispatchControl,
  type RemoteRuntimeDispatchControlDeps
} from '../src/main/agent/remote-runtime/remote-runtime-dispatch-control'

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

const desktopIdentity = {
  runtimeSessionId: 'runtime-1',
  sessionId: 'phi-1',
  projectId: 'project-1',
  cwd: '/remote/project',
  resourceCwd: '/resource/project'
}

function desktopFixture(): {
  deps: AppRemoteDesktopToolsDeps
  calls: string[]
  setBinding(value: string): void
  setSessionCwd(value: string): void
  setServers(global: unknown[], project: unknown[]): void
  mcp: NonNullable<
    Awaited<ReturnType<ReturnType<typeof createAppRemoteDesktopTools>>>['desktopMcp']
  >
  options(): DesktopMcpOptions | undefined
} {
  const calls: string[] = []
  let binding = 'binding-1'
  let sessionCwd = desktopIdentity.resourceCwd
  let globalServers: unknown[] = []
  let projectServers: unknown[] = []
  let options: DesktopMcpOptions | undefined
  const mcp = {
    identity: desktopIdentity,
    tools: [],
    catalog: [],
    skipped: [],
    approvalFor: () => 'write' as const,
    retire: () => calls.push('mcp.retire'),
    close: async () => {
      calls.push('mcp.close')
    }
  }
  const deps: AppRemoteDesktopToolsDeps = {
    agentDir: '/agent',
    sessions: { findById: () => ({ cwd: sessionCwd }) },
    workspace: { resolveBinding: () => ({ cacheKey: binding }) },
    catalogs: {
      listGlobalMcpServers: async () => globalServers as never,
      loadProjectMcp: async () => ({ summaries: [], runtimeServers: projectServers as never })
    },
    adapters: {
      createMcp: async (input) => {
        options = input
        calls.push('mcp.create')
        return mcp
      }
    },
    skippedMcp: { notify: () => calls.push('mcp.notify') }
  }
  return {
    deps,
    calls,
    setBinding: (value) => {
      binding = value
    },
    setSessionCwd: (value) => {
      sessionCwd = value
    },
    setServers: (global, project) => {
      globalServers = global
      projectServers = project
    },
    mcp,
    options: () => options
  }
}

test('desktop host resource loading is empty when no MCP server is selected', async () => {
  const fixture = desktopFixture()
  const resources = await createAppRemoteDesktopTools(fixture.deps)(
    desktopIdentity,
    new AbortController().signal
  )

  assert.deepEqual(resources, {})
  assert.deepEqual(fixture.calls, ['mcp.notify'])
})

test('desktop host resource loading retains only the kernel MCP broker', async () => {
  const fixture = desktopFixture()
  fixture.setServers(
    [
      { name: 'shared', enabled: true },
      { name: 'disabled', enabled: false }
    ],
    [{ name: 'shared' }, { name: 'remote' }]
  )
  const resources = await createAppRemoteDesktopTools(fixture.deps)(
    desktopIdentity,
    new AbortController().signal
  )

  assert.equal(resources.desktopMcp, fixture.mcp)
  assert.deepEqual(fixture.options()?.serverNames, ['shared', 'remote'])
  assert.equal(fixture.options()?.approvalFor('tool', {}), 'write')
  assert.deepEqual(fixture.calls, ['mcp.create', 'mcp.notify'])

  fixture.setBinding('binding-2')
  assert.throws(() => fixture.options()?.beforeDispatch?.(), /项目绑定已改变/)
  await resources.close?.()
  assert.deepEqual(fixture.calls, ['mcp.create', 'mcp.notify', 'mcp.retire', 'mcp.close'])
})

test('desktop MCP loading rechecks session identity after catalog reads', async () => {
  const fixture = desktopFixture()
  const catalog = deferred<never[]>()
  fixture.deps.catalogs.listGlobalMcpServers = () => catalog.promise
  const loading = createAppRemoteDesktopTools(fixture.deps)(
    desktopIdentity,
    new AbortController().signal
  )
  fixture.setSessionCwd('/changed')
  catalog.resolve([])

  await assert.rejects(loading, /项目绑定已改变/)
  assert.deepEqual(fixture.calls, [])
})
