import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import * as jsxRuntime from 'react/jsx-runtime'
import ts from 'typescript'
import type {
  AutoCompactionApi,
  CurrentAutoCompactionSettings,
  CurrentContextUsage,
  ManualCompactionTarget
} from '../src/shared/contextUsageTypes'
import type { AgentEventSummary } from '../src/renderer/src/types'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const first: ManualCompactionTarget = {
  sessionPath: '/first.jsonl',
  phiSessionId: 'first',
  sessionGeneration: 1
}
const second: ManualCompactionTarget = {
  sessionPath: '/second.jsonl',
  phiSessionId: 'second',
  sessionGeneration: 2
}
const settingsFor = (
  target: ManualCompactionTarget,
  threshold = 70
): CurrentAutoCompactionSettings => ({
  ...target,
  enabled: true,
  thresholdPercent: threshold,
  defaults: { enabled: true, thresholdPercent: 80, thresholdTokens: 0 },
  overrides: { thresholdPercent: threshold as 70 | 80 | 90 }
})

type Slot =
  | { kind: 'state'; value: unknown; set: (value: unknown) => void }
  | { kind: 'ref'; value: { current: unknown } }
  | { kind: 'effect'; deps: readonly unknown[]; cleanup?: () => void }

/** Complete production component/hook with deterministic React effects and deferred IPC. */
function rendererHarness<State>(
  path: string,
  name: string,
  api: Record<string, unknown>,
  args: () => unknown[]
): () => State {
  const slots: Slot[] = []
  let cursor = 0
  const pending: Array<() => void> = []
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
      if (slot.kind !== 'state') throw new Error('Unexpected hook order')
      return [slot.value as T, slot.set]
    },
    useRef<T>(initial: T): { current: T } {
      const index = cursor++
      slots[index] ??= { kind: 'ref', value: { current: initial } }
      const slot = slots[index]
      if (slot.kind !== 'ref') throw new Error('Unexpected hook order')
      return slot.value as { current: T }
    },
    useId: () => 'threshold-label',
    useEffect(setup: () => void | (() => void), deps: readonly unknown[]): void {
      const index = cursor++
      const previous = slots[index]
      if (
        previous?.kind === 'effect' &&
        previous.deps.length === deps.length &&
        previous.deps.every((value, i) => Object.is(value, deps[i]))
      )
        return
      if (previous?.kind === 'effect') previous.cleanup?.()
      const slot: Extract<Slot, { kind: 'effect' }> = { kind: 'effect', deps }
      slots[index] = slot
      pending.push(() => {
        slot.cleanup = setup() || undefined
      })
    }
  }
  const module = { exports: {} as Record<string, unknown> }
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX
    }
  }).outputText
  runInNewContext(code, {
    module,
    exports: module.exports,
    require(specifier: string): unknown {
      if (specifier === 'react') return react
      if (specifier === 'react/jsx-runtime') return jsxRuntime
      if (specifier === '@mui/material') return new Proxy({}, { get: (_, key) => key })
      if (specifier.endsWith('/rendererApi')) return { getRendererApi: () => api }
      throw new Error(`Unexpected runtime import ${specifier}`)
    },
    window: { setInterval: () => 1, clearInterval: () => {} },
    Promise,
    Error,
    Set,
    Map
  })
  const render = module.exports[name] as (...values: unknown[]) => State
  return () => {
    cursor = 0
    const result = render(...args())
    for (const effect of pending.splice(0)) effect()
    return result
  }
}

type Element = { type: string; props: Record<string, unknown> }
function elements(value: unknown, type: string): Element[] {
  if (Array.isArray(value)) return value.flatMap((item) => elements(item, type))
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const node = value as Element
  return [
    ...(node.type === type ? [node] : []),
    ...Object.values(node.props).flatMap((item) => elements(item, type))
  ]
}

type SettingsProps = {
  target: ManualCompactionTarget | null
  disabled?: boolean
  compacting?: boolean
  compactDisabled?: boolean
  onCompact?: () => void
}
async function settingsHarness(overrides: Partial<AutoCompactionApi> = {}): Promise<{
  read: () => Element
  setProps: (props: SettingsProps) => void
  saveEnabled: (value: boolean) => void
  calls: Array<{ target: ManualCompactionTarget; patch: unknown }>
}> {
  let props: SettingsProps = { target: first }
  const calls: Array<{ target: ManualCompactionTarget; patch: unknown }> = []
  const api: AutoCompactionApi = {
    getAutoCompactionSettings:
      overrides.getAutoCompactionSettings ?? (async (target) => settingsFor(target)),
    setAutoCompactionSettings: async (target, patch) => {
      calls.push({ target, patch })
      return overrides.setAutoCompactionSettings
        ? overrides.setAutoCompactionSettings(target, patch)
        : { ...settingsFor(target), enabled: patch.enabled ?? true }
    }
  }
  const read = rendererHarness<Element>(
    'src/renderer/src/features/chat/components/AutoCompactionSettingsSection.tsx',
    'AutoCompactionSettingsSection',
    { ...api },
    () => [props]
  )
  read()
  await flush()
  return {
    read,
    setProps(next): void {
      props = next
      read()
    },
    saveEnabled(value): void {
      const onChange = elements(read(), 'Switch')[0]?.props.onChange as (
        event: null,
        checked: boolean
      ) => void
      assert.ok(onChange)
      onChange(null, value)
    },
    calls
  }
}

const alert = (tree: Element): unknown =>
  elements(tree, 'Typography').find((node) => node.props.role === 'alert')?.props.children
const threshold = (tree: Element): unknown => elements(tree, 'Select')[0]?.props.value

test('an old save failure does not erase the newly active session load error', async () => {
  const pending = deferred<CurrentAutoCompactionSettings>()
  const f = await settingsHarness({
    setAutoCompactionSettings: () => pending.promise,
    getAutoCompactionSettings: async (target) => {
      if (target.phiSessionId === second.phiSessionId) throw new Error('Second session failed')
      return settingsFor(target)
    }
  })
  f.saveEnabled(false)
  f.setProps({ target: second })
  await flush()
  assert.equal(alert(f.read()), 'Second session failed')
  pending.reject(new Error('First session save failed'))
  await flush()
  assert.equal(alert(f.read()), 'Second session failed')
})

test('A to B to A does not apply the old save receipt over current authoritative settings', async () => {
  const pending = deferred<CurrentAutoCompactionSettings>()
  let thresholdPercent = 70
  const f = await settingsHarness({
    setAutoCompactionSettings: () => pending.promise,
    getAutoCompactionSettings: async (target) => settingsFor(target, thresholdPercent)
  })
  f.saveEnabled(false)
  f.setProps({ target: second })
  await flush()
  thresholdPercent = 80
  f.setProps({ target: first })
  await flush()
  pending.resolve(settingsFor(first, 90))
  await flush()
  f.read()
  await flush()
  assert.equal(threshold(f.read()), 80)
})

test('rapid same-target saves dispatch only once until the accepted request settles', async () => {
  const pending = deferred<CurrentAutoCompactionSettings>()
  const f = await settingsHarness({ setAutoCompactionSettings: () => pending.promise })
  const onChange = elements(f.read(), 'Switch')[0].props.onChange as (
    event: null,
    checked: boolean
  ) => void
  onChange(null, false)
  onChange(null, true)
  assert.equal(f.calls.length, 1)
  pending.resolve({ ...settingsFor(first), enabled: false })
  await flush()
  assert.equal(elements(f.read(), 'Switch')[0].props.checked, false)
})

test('finishing a peer save does not unlock the current session save', async () => {
  const a = deferred<CurrentAutoCompactionSettings>()
  const b = deferred<CurrentAutoCompactionSettings>()
  const f = await settingsHarness({
    setAutoCompactionSettings: (target) =>
      target.phiSessionId === first.phiSessionId ? a.promise : b.promise
  })
  f.saveEnabled(false)
  f.setProps({ target: second })
  await flush()
  f.saveEnabled(false)
  a.resolve(settingsFor(first))
  await flush()
  assert.equal(elements(f.read(), 'Switch')[0].props.disabled, true)
  assert.equal(f.calls.length, 2)
  b.resolve({ ...settingsFor(second, 90), enabled: false })
  await flush()
  assert.equal(elements(f.read(), 'Switch')[0].props.disabled, false)
  assert.equal(threshold(f.read()), 90)
})

test('a failed navigation attempt keeps the current settings failure visible', async () => {
  const pending = deferred<CurrentAutoCompactionSettings>()
  const f = await settingsHarness({ setAutoCompactionSettings: () => pending.promise })
  f.saveEnabled(false)
  f.setProps({ target: { ...first } })
  pending.reject(new Error('Current save failed'))
  await flush()
  assert.equal(alert(f.read()), 'Current save failed')
  assert.equal(threshold(f.read()), 70)
})

test('settings from an old get are ignored after navigating to another session', async () => {
  const pending = deferred<CurrentAutoCompactionSettings>()
  const f = await settingsHarness({
    getAutoCompactionSettings: (target) =>
      target.phiSessionId === first.phiSessionId
        ? pending.promise
        : Promise.resolve(settingsFor(target, 90))
  })
  f.setProps({ target: second })
  await flush()
  pending.resolve(settingsFor(first, 70))
  await flush()
  assert.equal(threshold(f.read()), 90)
})

test('disabled and manually compacting settings cannot dispatch a stale change handler', async () => {
  const f = await settingsHarness()
  for (const props of [
    { target: first, disabled: true },
    { target: first, compacting: true }
  ]) {
    f.setProps(props)
    f.saveEnabled(false)
    assert.equal(elements(f.read(), 'Switch')[0].props.disabled, true)
  }
  assert.equal(f.calls.length, 0)
})

test('threshold presets and inherited defaults reuse the existing patch API', async () => {
  const f = await settingsHarness()
  for (const value of [70, 80, 90, 'default']) {
    const change = elements(f.read(), 'Select')[0].props.onChange as (event: {
      target: { value: unknown }
    }) => void
    change({ target: { value } })
    await flush()
  }
  const restore = elements(f.read(), 'Button').find(
    (node) => node.props.children === '恢复 SDK 默认'
  )
  ;(restore?.props.onClick as () => void)()
  await flush()
  assert.deepEqual(
    f.calls.map((call) => JSON.parse(JSON.stringify(call.patch))),
    [
      { thresholdPercent: 70 },
      { thresholdPercent: 80 },
      { thresholdPercent: 90 },
      { thresholdPercent: null },
      { enabled: null, thresholdPercent: null }
    ]
  )
})

test('context usage ignores a late old-session reply and peer-session events', async () => {
  const pending = deferred<CurrentContextUsage>()
  let target = first
  let listener!: (event: AgentEventSummary) => void
  let calls = 0
  const api = {
    getCurrentContextUsage: () => {
      calls += 1
      return calls === 1
        ? pending.promise
        : Promise.resolve({ ...target, usage: { tokens: 20, contextWindow: 100, percent: 20 } })
    },
    onAgentEvent: (next: typeof listener) => {
      listener = next
      return () => {}
    }
  }
  const read = rendererHarness<{ usage: { tokens: number } | null; loading: boolean }>(
    'src/renderer/src/features/chat/hooks/useContextUsage.ts',
    'useContextUsage',
    api,
    () => [target, 'fixture/model', false]
  )
  read()
  target = second
  read()
  await flush()
  pending.resolve({ ...first, usage: { tokens: 90, contextWindow: 100, percent: 90 } })
  await flush()
  assert.equal(read().usage?.tokens, 20)
  const before = calls
  listener({
    type: 'auto_compaction_end',
    phiSessionId: first.phiSessionId!,
    sessionPath: first.sessionPath!,
    sessionGeneration: first.sessionGeneration
  })
  await flush()
  assert.equal(calls, before)
  listener({
    type: 'context_compacted',
    phiSessionId: second.phiSessionId!,
    sessionPath: second.sessionPath!,
    sessionGeneration: second.sessionGeneration
  })
  await flush()
  assert.equal(calls, before + 1)
})

function appCallback<T>(name: string, context: Record<string, unknown>): T {
  const syntax = ts.createSourceFile(
    'App.tsx',
    readFileSync('src/renderer/src/App.tsx', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let initializer: ts.Expression | undefined
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
      initializer = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.ok(initializer)
  const code = ts.transpileModule(`(${initializer.getText(syntax)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return runInNewContext(code, {
    useCallback: (callback: unknown) => callback,
    Set,
    JSON,
    ...context
  }) as T
}

function manualHarness(pending: Promise<unknown>): {
  compact: (target: ManualCompactionTarget) => Promise<void>
  setTarget: (target: ManualCompactionTarget) => void
  notices: unknown[]
  refreshes: () => number
  calls: ManualCompactionTarget[]
} {
  let target = first
  let refreshes = 0
  const notices: unknown[] = []
  const calls: ManualCompactionTarget[] = []
  const compact = appCallback<(target: ManualCompactionTarget) => Promise<void>>(
    'onCompactContext',
    {
      useSessionStore: {
        getState: () => ({
          activePhiSessionId: target.phiSessionId,
          activeSessionPath: target.sessionPath,
          activeSessionGeneration: target.sessionGeneration
        })
      },
      rendererApi: {
        compactCurrentSession: (input: ManualCompactionTarget) => {
          calls.push(input)
          return pending
        }
      },
      compactingSessionKeysRef: { current: new Set<string>() },
      setCompactingSessions: () => {},
      showSnackbar: (...values: unknown[]) => notices.push(values),
      showSnackbarError: (...values: unknown[]) => notices.push(values),
      setContextUsageRefreshKey: () => {
        refreshes += 1
      }
    }
  )
  return {
    compact,
    setTarget: (next) => {
      target = next
    },
    notices,
    refreshes: () => refreshes,
    calls
  }
}

test('manual compaction success from a background session does not refresh or notify the new active session', async () => {
  const pending = deferred<void>()
  const f = manualHarness(pending.promise)
  const compacting = f.compact(first)
  f.setTarget(second)
  pending.resolve()
  await compacting
  assert.equal(f.notices.length, 0)
  assert.equal(f.refreshes(), 0)
})

test('manual compaction failure from a background session does not notify the new active session', async () => {
  const pending = deferred<void>()
  const f = manualHarness(pending.promise)
  const compacting = f.compact(first)
  f.setTarget(second)
  pending.reject(new Error('Old compaction failed'))
  await compacting
  assert.equal(f.notices.length, 0)
})

test('manual compaction refuses a target that was already replaced before dispatch', async () => {
  const f = manualHarness(Promise.resolve())
  f.setTarget(second)
  await f.compact(first)
  assert.equal(f.calls.length, 0)
})

test('manual compaction keeps its same-target lock and reports a confirmed current success', async () => {
  const pending = deferred<void>()
  const f = manualHarness(pending.promise)
  const compacting = f.compact(first)
  await f.compact(first)
  assert.equal(f.calls.length, 1)
  pending.resolve()
  await compacting
  assert.equal(f.notices.length, 1)
  assert.equal(f.refreshes(), 1)
})

test('manual compaction ignores a same-session reply after its applied generation changes', async () => {
  const pending = deferred<void>()
  const f = manualHarness(pending.promise)
  const compacting = f.compact(first)
  f.setTarget({ ...first, sessionGeneration: first.sessionGeneration + 1 })
  pending.resolve()
  await compacting
  assert.equal(f.notices.length, 0)
  assert.equal(f.refreshes(), 0)
})

test('manual compaction reports a real failure while its original session remains active', async () => {
  const pending = deferred<void>()
  const f = manualHarness(pending.promise)
  const compacting = f.compact(first)
  pending.reject(new Error('Current compaction failed'))
  await compacting
  assert.equal(f.notices.length, 1)
  assert.equal(f.refreshes(), 0)
})

function stopHarness(pending: Promise<void>): {
  stop: () => Promise<void>
  setTarget: (target: ManualCompactionTarget) => void
  writes: unknown[]
  isSendingRef: { current: boolean }
} {
  let target = first
  const writes: unknown[] = []
  const isSendingRef = { current: true }
  const stop = appCallback<() => Promise<void>>('onStopGeneration', {
    rendererApi: { stopGeneration: () => pending },
    sendRequestRef: { current: 3 },
    isSendingRef,
    useSessionStore: {
      getState: () => ({
        activePhiSessionId: target.phiSessionId,
        activeSessionPath: target.sessionPath,
        activeSessionGeneration: target.sessionGeneration
      })
    },
    setIsSendingMessage: (value: unknown) => writes.push(value),
    setPendingApproval: (value: unknown) => writes.push(value),
    setPendingUserInteraction: (value: unknown) => writes.push(value)
  })
  return {
    stop,
    setTarget: (next) => {
      target = next
    },
    writes,
    isSendingRef
  }
}

test('a late stop reply cannot clear the newly active peer session approvals or sending state', async () => {
  const pending = deferred<void>()
  const f = stopHarness(pending.promise)
  const stopping = f.stop()
  f.setTarget(second)
  pending.resolve()
  await stopping
  assert.equal(f.writes.length, 0)
  assert.equal(f.isSendingRef.current, true)
})

test('a late stop reply cannot clear a newer generation of the same session', async () => {
  const pending = deferred<void>()
  const f = stopHarness(pending.promise)
  const stopping = f.stop()
  f.setTarget({ ...first, sessionGeneration: first.sessionGeneration + 1 })
  pending.resolve()
  await stopping
  assert.equal(f.writes.length, 0)
})

test('stopping the current original session retains the existing local cleanup behavior', async () => {
  const f = stopHarness(Promise.resolve())
  await f.stop()
  assert.deepEqual(f.writes, [false, null, null])
  assert.equal(f.isSendingRef.current, false)
})
