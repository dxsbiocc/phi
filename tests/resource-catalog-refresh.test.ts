import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import type { McpServerSummary, PromptAgentSummary, SkillSummary } from '../src/renderer/src/types'
import type { PhiPluginListItem, PhiPluginMutationResult } from '../src/shared/phiPluginTypes'
import type { SkillCatalogState } from '../src/renderer/src/features/skill/hooks/useSkillCatalog'
import type { McpServerCatalogState } from '../src/renderer/src/features/mcp/hooks/useMcpServerCatalog'
import type { PhiPluginsState } from '../src/renderer/src/features/phi-plugin/hooks/usePhiPlugins'
import { formatPhiPluginProblems } from '../src/renderer/src/features/phi-plugin/lib/phiPlugins'
import { retainSelectedCatalogId } from '../src/renderer/src/lib/catalogSelection'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type Slot =
  | { kind: 'state'; value: unknown; set: (value: unknown) => void }
  | { kind: 'ref'; ref: { current: unknown } }
  | { kind: 'callback'; value: unknown; deps: readonly unknown[] }
  | {
      kind: 'effect'
      setup: () => void | (() => void)
      cleanup?: () => void
      deps: readonly unknown[]
    }

/** Execute the complete production hook with deterministic React state and effect scheduling. */
function hookHarness<State>(
  path: string,
  name: string,
  api: Record<string, unknown>,
  args: unknown[] = []
): { read: () => State; runTimers: () => void; restartEffects: () => void } {
  const slots: Slot[] = []
  let cursor = 0
  let timerId = 0
  const timers = new Map<number, () => void>()
  const pendingEffects: Array<Extract<Slot, { kind: 'effect' }>> = []
  const sameDeps = (left: readonly unknown[], right: readonly unknown[]): boolean =>
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const react = {
    useState<T>(initial: T | (() => T)): [T, (value: T | ((current: T) => T)) => void] {
      const index = cursor++
      if (!slots[index]) {
        const slot: Extract<Slot, { kind: 'state' }> = {
          kind: 'state',
          value: typeof initial === 'function' ? (initial as () => T)() : initial,
          set(value): void {
            slot.value = typeof value === 'function' ? value(slot.value) : value
          }
        }
        slots[index] = slot
      }
      const slot = slots[index]
      assert.equal(slot.kind, 'state')
      if (slot.kind !== 'state') throw new Error('Unexpected hook order')
      return [slot.value as T, slot.set]
    },
    useRef<T>(initial: T): { current: T } {
      const index = cursor++
      slots[index] ??= { kind: 'ref', ref: { current: initial } }
      const slot = slots[index]
      if (slot.kind !== 'ref') throw new Error('Unexpected hook order')
      return slot.ref as { current: T }
    },
    useCallback<T>(callback: T, deps: readonly unknown[]): T {
      const index = cursor++
      const slot = slots[index]
      if (slot?.kind === 'callback' && sameDeps(slot.deps, deps)) return slot.value as T
      slots[index] = { kind: 'callback', value: callback, deps }
      return callback
    },
    useEffect(setup: () => void | (() => void), deps: readonly unknown[]): void {
      const index = cursor++
      const slot = slots[index]
      if (slot?.kind === 'effect' && sameDeps(slot.deps, deps)) return
      if (slot?.kind === 'effect') slot.cleanup?.()
      const next: Extract<Slot, { kind: 'effect' }> = { kind: 'effect', setup, deps }
      slots[index] = next
      pendingEffects.push(next)
    }
  }
  const module = { exports: {} as Record<string, unknown> }
  const source = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  runInNewContext(source, {
    module,
    exports: module.exports,
    require(specifier: string): unknown {
      if (specifier === 'react') return react
      if (specifier.endsWith('/catalogSelection')) return { retainSelectedCatalogId }
      if (specifier === '../lib/phiPlugins') return { formatPhiPluginProblems }
      throw new Error(`Unexpected runtime import: ${specifier}`)
    },
    window: {
      api,
      setTimeout(callback: () => void): number {
        timers.set(++timerId, callback)
        return timerId
      },
      clearTimeout(id: number): void {
        timers.delete(id)
      }
    },
    Promise,
    Error
  })
  const hook = module.exports[name] as (...values: unknown[]) => State
  return {
    read(): State {
      cursor = 0
      const state = hook(...args)
      for (const effect of pendingEffects.splice(0)) effect.cleanup = effect.setup() || undefined
      return state
    },
    runTimers(): void {
      const callbacks = [...timers.values()]
      timers.clear()
      for (const callback of callbacks) callback()
    },
    restartEffects(): void {
      for (const slot of slots) {
        if (slot.kind !== 'effect') continue
        slot.cleanup?.()
        slot.cleanup = slot.setup() || undefined
      }
    }
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

const skillHook = 'src/renderer/src/features/skill/hooks/useSkillCatalog.ts'
const mcpHook = 'src/renderer/src/features/mcp/hooks/useMcpServerCatalog.ts'
const pluginHook = 'src/renderer/src/features/phi-plugin/hooks/usePhiPlugins.ts'

function skill(name: string, enabled = false): SkillSummary {
  return {
    id: name,
    name,
    description: name,
    filePath: `/skills/${name}/SKILL.md`,
    source: 'bundled',
    scope: 'user',
    sourceCategory: 'bundled',
    sourceCategoryLabel: '内置',
    enabled,
    globalEnabled: enabled,
    globalOverride: null,
    projectOverride: null,
    core: false,
    disabled: !enabled
  }
}

function plugin(enabled = false): PhiPluginListItem {
  return {
    id: 'fixture',
    title: 'Fixture',
    summary: 'Fixture',
    version: '1.0.0',
    source: 'local',
    enabled,
    installedAt: '2026-10-07',
    directory: '/plugins/fixture',
    agents: [],
    skills: [],
    scriptTools: [],
    environments: []
  }
}

test('skill navigation reads coalesce while prompt-agent refreshes remain fresh and retryable', async () => {
  const skillReads: Array<Deferred<SkillSummary[]>> = []
  const promptReads: Array<Deferred<PromptAgentSummary[]>> = []
  const harness = hookHarness<SkillCatalogState>(
    skillHook,
    'useSkillCatalog',
    {
      listSkills: () => {
        const read = deferred<SkillSummary[]>()
        skillReads.push(read)
        return read.promise
      },
      listPromptAgents: () => {
        const read = deferred<PromptAgentSummary[]>()
        promptReads.push(read)
        return read.promise
      }
    },
    [() => '/a']
  )
  const initial = harness.read()
  initial.setActiveSkillId('kept')
  const first = initial.refreshSkillsForNavigation()
  const second = initial.refreshSkillsForNavigation()
  const promptFirst = initial.refreshPromptAgents()
  const promptSecond = initial.refreshPromptAgents()
  await flush()
  assert.equal(skillReads.length, 1)
  assert.equal(promptReads.length, 2)
  assert.equal(harness.read().isLoadingSkills, true)
  assert.strictEqual(harness.read().refreshSkills, initial.refreshSkills)
  assert.strictEqual(harness.read().refreshSkillsForNavigation, initial.refreshSkillsForNavigation)
  skillReads[0].resolve([skill('kept')])
  promptReads[0].resolve([])
  promptReads[1].resolve([
    { id: 'agent', name: 'Agent', description: 'Agent', source: 'user', trigger: '/agent' }
  ])
  await Promise.all([first, second, promptFirst, promptSecond])
  assert.equal(harness.read().activeSkillId, 'kept')
  assert.equal(harness.read().promptAgents[0].id, 'agent')
  assert.equal(harness.read().isLoadingSkills, false)

  const rejected = [initial.refreshSkillsForNavigation(), initial.refreshSkillsForNavigation()]
  const rejectionResults = Promise.allSettled(rejected)
  const promptRejected = initial.refreshPromptAgents()
  const promptRejection = assert.rejects(promptRejected, /prompt read failed/)
  await flush()
  assert.equal(skillReads.length, 2)
  skillReads[1].reject(new Error('skill read failed'))
  promptReads[2].reject(new Error('prompt read failed'))
  assert.equal(
    (await rejectionResults).every((result) => result.status === 'rejected'),
    true
  )
  await promptRejection
  assert.equal(harness.read().isLoadingSkills, false)
  const retry = initial.refreshSkillsForNavigation()
  const promptRetry = initial.refreshPromptAgents()
  await flush()
  assert.equal(skillReads.length, 3)
  assert.equal(promptReads.length, 4)
  skillReads[2].resolve([skill('retry')])
  promptReads[3].resolve([])
  await Promise.all([retry, promptRetry])
  assert.equal(harness.read().skills[0].id, 'retry')
})

test('skill cwd changes start fresh reads and stale paths cannot replace the current catalog', async () => {
  let cwd = '/a'
  const reads: Array<{ cwd: string; deferred: Deferred<SkillSummary[]> }> = []
  const prompts: Array<Deferred<PromptAgentSummary[]>> = []
  const harness = hookHarness<SkillCatalogState>(
    skillHook,
    'useSkillCatalog',
    {
      listSkills: (path: string) => {
        const read = deferred<SkillSummary[]>()
        reads.push({ cwd: path, deferred: read })
        return read.promise
      },
      listPromptAgents: () => {
        const read = deferred<PromptAgentSummary[]>()
        prompts.push(read)
        return read.promise
      }
    },
    [() => cwd]
  )
  const state = harness.read()
  const old = state.refreshSkillsForNavigation()
  const oldPrompts = state.refreshPromptAgents()
  cwd = '/b'
  const current = state.refreshSkillsForNavigation()
  const currentPrompts = state.refreshPromptAgents()
  const joined = state.refreshSkillsForNavigation()
  await flush()
  assert.deepEqual(
    reads.map((read) => read.cwd),
    ['/a', '/b']
  )
  reads[0].deferred.resolve([skill('old')])
  prompts[0].resolve([{ id: 'old', name: 'Old', description: '', source: 'user', trigger: '' }])
  await Promise.all([old, oldPrompts])
  assert.equal(harness.read().skills.length, 0)
  assert.equal(harness.read().promptAgents.length, 0)
  assert.equal(harness.read().isLoadingSkills, true)
  const joinedAfterOld = state.refreshSkillsForNavigation()
  await flush()
  assert.equal(reads.length, 2)
  reads[1].deferred.resolve([skill('current')])
  prompts[1].resolve([])
  await Promise.all([current, currentPrompts, joined, joinedAfterOld])
  assert.equal(harness.read().skills[0].id, 'current')
  assert.equal(harness.read().isLoadingSkills, false)
})

test('skill enablement forces a post-write read and ignores the earlier pending snapshot', async () => {
  const reads: Array<Deferred<SkillSummary[]>> = []
  const write = deferred<void>()
  const harness = hookHarness<SkillCatalogState>(
    skillHook,
    'useSkillCatalog',
    {
      listSkills: () => {
        const read = deferred<SkillSummary[]>()
        reads.push(read)
        return read.promise
      },
      setEnablement: () => write.promise
    },
    [() => '/a']
  )
  const state = harness.read()
  const old = state.refreshSkillsForNavigation()
  const mutation = state.setGlobalEnabled(skill('fixture'), true)
  await flush()
  assert.equal(reads.length, 1)
  assert.equal(harness.read().busySkillId, 'fixture')
  write.resolve()
  await flush()
  assert.equal(reads.length, 2)
  const joinedFresh = state.refreshSkillsForNavigation()
  await flush()
  assert.equal(reads.length, 2)
  reads[1].resolve([skill('fixture', true)])
  assert.equal((await mutation)[0].enabled, true)
  await joinedFresh
  reads[0].resolve([skill('fixture', false)])
  await old
  assert.equal(harness.read().skills[0].enabled, true)
  assert.equal(harness.read().busySkillId, null)
  assert.equal(harness.read().isLoadingSkills, false)
})

test('skill deletion invalidates older reads without repeating its authoritative backend snapshot', async () => {
  const read = deferred<SkillSummary[]>()
  const deletion = deferred<SkillSummary[]>()
  let reads = 0
  const harness = hookHarness<SkillCatalogState>(
    skillHook,
    'useSkillCatalog',
    {
      listSkills: () => {
        reads += 1
        return read.promise
      },
      deleteSkill: () => deletion.promise
    },
    [() => '/a']
  )
  const state = harness.read()
  const old = state.refreshSkillsForNavigation()
  const mutation = state.deleteSkill(skill('removed'))
  await flush()
  deletion.resolve([skill('remaining')])
  await mutation
  read.resolve([skill('removed')])
  await old
  assert.equal(reads, 1)
  assert.equal(harness.read().skills[0].id, 'remaining')
  assert.equal(harness.read().isLoadingSkills, false)
})

test('a skill mutation in the old cwd does not invalidate the new cwd read', async () => {
  let cwd = '/a'
  const write = deferred<void>()
  const reads: Array<{ cwd: string; deferred: Deferred<SkillSummary[]> }> = []
  const harness = hookHarness<SkillCatalogState>(
    skillHook,
    'useSkillCatalog',
    {
      listSkills: (path: string) => {
        const read = deferred<SkillSummary[]>()
        reads.push({ cwd: path, deferred: read })
        return read.promise
      },
      setEnablement: () => write.promise
    },
    [() => cwd]
  )
  const state = harness.read()
  const mutation = state.setGlobalEnabled(skill('old'), true)
  cwd = '/b'
  const current = state.refreshSkillsForNavigation()
  await flush()
  write.resolve()
  await flush()
  assert.deepEqual(
    reads.map((read) => read.cwd),
    ['/b', '/a']
  )
  reads[0].deferred.resolve([skill('current')])
  await current
  reads[1].deferred.resolve([skill('old', true)])
  await mutation
  assert.equal(harness.read().skills[0].id, 'current')
})

test('MCP navigation reads coalesce by cwd, preserve selection and retry after errors', async () => {
  let cwd = '/a'
  const reads: Array<Deferred<McpServerSummary[]>> = []
  const harness = hookHarness<McpServerCatalogState>(
    mcpHook,
    'useMcpServerCatalog',
    {
      listMcpServers: () => {
        const read = deferred<McpServerSummary[]>()
        reads.push(read)
        return read.promise
      }
    },
    [() => cwd]
  )
  const state = harness.read()
  state.setActiveMcpServerId('current')
  const old = state.refreshMcpServersForNavigation()
  const joinedOld = state.refreshMcpServersForNavigation()
  cwd = '/b'
  const current = state.refreshMcpServersForNavigation()
  const joinedCurrent = state.refreshMcpServersForNavigation()
  await flush()
  assert.equal(reads.length, 2)
  reads[0].resolve([{ id: 'old', name: 'Old', status: 'configured' }])
  await Promise.all([old, joinedOld])
  assert.equal(harness.read().mcpServers.length, 0)
  const joinedAfterOld = state.refreshMcpServersForNavigation()
  await flush()
  assert.equal(reads.length, 2)
  reads[1].resolve([{ id: 'current', name: 'Current', status: 'configured' }])
  await Promise.all([current, joinedCurrent, joinedAfterOld])
  assert.equal(harness.read().activeMcpServerId, 'current')
  assert.strictEqual(harness.read().refreshMcpServers, state.refreshMcpServers)
  assert.strictEqual(
    harness.read().refreshMcpServersForNavigation,
    state.refreshMcpServersForNavigation
  )
  const failed = state.refreshMcpServersForNavigation()
  const rejection = assert.rejects(failed, /MCP read failed/)
  await flush()
  reads[2].reject(new Error('MCP read failed'))
  await rejection
  const retry = state.refreshMcpServersForNavigation()
  await flush()
  assert.equal(reads.length, 4)
  reads[3].resolve([])
  await retry
  assert.equal(harness.read().activeMcpServerId, null)
})

function pluginApi(
  reads: Array<Deferred<PhiPluginListItem[]>>,
  calls: string[]
): Record<string, unknown> {
  return {
    listPhiPlugins: () => {
      calls.push('plugins')
      const read = deferred<PhiPluginListItem[]>()
      reads.push(read)
      return read.promise
    },
    listManagedEnvironments: async () => {
      calls.push('environments')
      return []
    },
    listInstalledPackages: async () => {
      calls.push('packages')
      return []
    },
    listEnvironmentBuilds: async () => {
      calls.push('builds')
      return []
    }
  }
}

test('plugin initial and overlapping navigation reads share IPC while public refresh clears feedback and retries', async () => {
  const reads: Array<Deferred<PhiPluginListItem[]>> = []
  const calls: string[] = []
  const harness = hookHarness<PhiPluginsState>(pluginHook, 'usePhiPlugins', pluginApi(reads, calls))
  const state = harness.read()
  harness.runTimers()
  state.showError('Previous feedback')
  const first = state.refreshForNavigation()
  const second = state.refreshForNavigation()
  assert.equal(harness.read().error, null)
  await flush()
  assert.deepEqual(calls, ['plugins', 'environments', 'packages', 'builds'])
  reads[0].reject(new Error('plugin read failed'))
  await Promise.all([first, second])
  assert.match(harness.read().error ?? '', /plugin read failed/)
  assert.equal(harness.read().loading, false)
  const retry = state.refresh()
  await flush()
  assert.equal(reads.length, 2)
  reads[1].resolve([plugin()])
  await retry
  assert.equal(harness.read().plugins[0].id, 'fixture')
  assert.equal(harness.read().error, null)
  assert.strictEqual(harness.read().refresh, state.refresh)
  assert.strictEqual(harness.read().refreshForNavigation, state.refreshForNavigation)
})

test('plugin mutations force fresh reads without clearing success feedback or accepting stale failures', async () => {
  const reads: Array<Deferred<PhiPluginListItem[]>> = []
  const calls: string[] = []
  const mutation = deferred<PhiPluginMutationResult>()
  const failedMutation = deferred<PhiPluginMutationResult>()
  const harness = hookHarness<PhiPluginsState>(pluginHook, 'usePhiPlugins', {
    ...pluginApi(reads, calls),
    setPhiPluginEnabled: () => mutation.promise,
    uninstallPhiPlugin: () => failedMutation.promise
  })
  const state = harness.read()
  harness.runTimers()
  const changing = state.setEnabled(
    { ...plugin(), distribution: 'local', trust: 'imported', environmentStatuses: [] },
    true
  )
  await flush()
  mutation.resolve({ ok: true, plugins: [plugin(true)], problems: [] })
  await flush()
  assert.equal(reads.length, 2)
  assert.equal(harness.read().busyPluginId, 'fixture')
  assert.match(harness.read().notice ?? '', /已启用 Fixture/)
  reads[1].resolve([plugin(true)])
  assert.equal(await changing, true)
  reads[0].reject(new Error('outdated failure'))
  await flush()
  assert.equal(harness.read().plugins[0].enabled, true)
  assert.equal(harness.read().error, null)
  assert.match(harness.read().notice ?? '', /已启用 Fixture/)
  assert.equal(harness.read().busyPluginId, null)
  const refreshing = state.refresh()
  assert.equal(harness.read().notice, null)
  await flush()
  assert.equal(reads.length, 3)
  reads[2].resolve([plugin(true)])
  await refreshing
  const failed = state.uninstall(harness.read().plugins[0])
  failedMutation.resolve({
    ok: false,
    plugins: [plugin(true)],
    problems: [
      { level: 'error', path: 'fixture', message: 'Cannot remove', displayMessage: 'Cannot remove' }
    ]
  })
  await flush()
  assert.equal(reads.length, 4)
  reads[3].resolve([plugin(true)])
  assert.equal(await failed, false)
  assert.match(harness.read().error ?? '', /插件卸载失败.*Cannot remove/)
  assert.equal(harness.read().notice, null)
})

test('plugin effect cleanup prevents a StrictMode setup from joining an invalidated request', async () => {
  const reads: Array<Deferred<PhiPluginListItem[]>> = []
  const calls: string[] = []
  const harness = hookHarness<PhiPluginsState>(pluginHook, 'usePhiPlugins', pluginApi(reads, calls))
  harness.read()
  harness.runTimers()
  await flush()
  harness.restartEffects()
  harness.runTimers()
  await flush()
  assert.equal(reads.length, 2)
  reads[0].resolve([plugin(false)])
  await flush()
  assert.equal(harness.read().plugins.length, 0)
  assert.equal(harness.read().loading, true)
  const joined = harness.read().refreshForNavigation()
  await flush()
  assert.equal(reads.length, 2)
  reads[1].resolve([plugin(true)])
  await joined
  assert.equal(harness.read().plugins[0].enabled, true)
  assert.equal(harness.read().loading, false)
})

for (const scenario of [
  {
    name: 'skill',
    path: skillHook,
    hook: 'useSkillCatalog',
    api: 'listSkills',
    navigation: 'refreshSkillsForNavigation',
    refresh: 'refreshSkills',
    field: 'skills'
  },
  {
    name: 'MCP',
    path: mcpHook,
    hook: 'useMcpServerCatalog',
    api: 'listMcpServers',
    navigation: 'refreshMcpServersForNavigation',
    refresh: 'refreshMcpServers',
    field: 'mcpServers'
  },
  {
    name: 'plugin',
    path: pluginHook,
    hook: 'usePhiPlugins',
    api: 'listPhiPlugins',
    navigation: 'refreshForNavigation',
    refresh: 'refresh',
    field: 'plugins'
  }
]) {
  test(`${scenario.name} public refresh starts a fresh read after an external write while navigation is pending`, async () => {
    const snapshot = (enabled: boolean): unknown[] =>
      scenario.name === 'skill'
        ? [skill('fixture', enabled)]
        : scenario.name === 'MCP'
          ? [{ id: 'fixture', name: 'Fixture', status: 'configured', enabled }]
          : [plugin(enabled)]
    let stored = snapshot(false)
    const reads: Array<{ snapshot: unknown[]; deferred: Deferred<unknown[]> }> = []
    const api = {
      [scenario.api]: (): Promise<unknown[]> => {
        const read = deferred<unknown[]>()
        reads.push({ snapshot: stored, deferred: read })
        return read.promise
      },
      writeFromAnotherSurface: async (): Promise<void> => {
        stored = snapshot(true)
      },
      listManagedEnvironments: async (): Promise<unknown[]> => [],
      listInstalledPackages: async (): Promise<unknown[]> => [],
      listEnvironmentBuilds: async (): Promise<unknown[]> => []
    }
    const harness = hookHarness<Record<string, unknown>>(
      scenario.path,
      scenario.hook,
      api,
      scenario.name === 'plugin' ? [] : [() => '/a']
    )
    const state = harness.read()
    const navigate = state[scenario.navigation] as () => Promise<void>
    const refresh = state[scenario.refresh] as () => Promise<void>
    const old = navigate()
    harness.runTimers()
    await flush()
    assert.equal(reads.length, 1)
    await api.writeFromAnotherSurface()
    const current = refresh()
    await flush()
    assert.equal(reads.length, 2)
    reads[1].deferred.resolve(reads[1].snapshot)
    await current
    reads[0].deferred.resolve(reads[0].snapshot)
    await old
    const displayed = harness.read()[scenario.field] as Array<{ enabled: boolean }>
    assert.equal(displayed[0].enabled, true)
  })
}
