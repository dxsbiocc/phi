import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type {
  RuntimeRecoveryApi,
  RuntimeRecoveryState,
  RuntimeRecoveryTarget,
  RuntimeSummaryContinuation
} from '../src/shared/runtimeRecoveryTypes'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runtimeRecoveryViewKey,
  selectedRecoveryModel
} from '../src/renderer/src/features/chat/lib/runtimeRecoveryState'

test('recovery UI: an owned generation advance preserves the view, while a peer or project switch changes it', () => {
  const original = {
    sessionId: 'A',
    projectId: 'project',
    sessionPath: 'phi-session:A',
    sessionGeneration: 0
  }
  assert.equal(
    runtimeRecoveryViewKey(original),
    runtimeRecoveryViewKey({ ...original, sessionGeneration: 1 })
  )
  assert.notEqual(
    runtimeRecoveryViewKey(original),
    runtimeRecoveryViewKey({ ...original, sessionId: 'B', sessionPath: 'phi-session:B' })
  )
  assert.notEqual(
    runtimeRecoveryViewKey(original),
    runtimeRecoveryViewKey({ ...original, projectId: 'peer' })
  )
})
test('recovery UI: replacement values can select only returned inventory and never parse arbitrary model metadata', () => {
  const available = [{ providerId: 'provider', modelId: 'known', name: 'Visible model' }]
  assert.deepEqual(selectedRecoveryModel(JSON.stringify(['provider', 'known']), available), {
    providerId: 'provider',
    modelId: 'known'
  })
  assert.equal(selectedRecoveryModel(JSON.stringify(['provider', 'unknown']), available), undefined)
  assert.equal(
    selectedRecoveryModel(
      '{"providerId":"provider","modelId":"known","apiKey":"private"}',
      available
    ),
    undefined
  )
})

type HookResult = ReturnType<
  typeof import('../src/renderer/src/features/chat/hooks/useRuntimeRecovery').useRuntimeRecovery
>
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
const original: RuntimeRecoveryTarget = {
  sessionId: 'A',
  projectId: 'project',
  sessionPath: 'phi-session:A',
  sessionGeneration: 0
}
function state(target: RuntimeRecoveryTarget): RuntimeRecoveryState {
  return {
    target,
    phase: 'recovery-required',
    canResume: true,
    message: 'Disconnected',
    summary: {
      content: 'Local summary',
      provenance: {
        kind: 'phi-timeline',
        version: 1,
        sourceSessionId: target.sessionId,
        projectId: target.projectId,
        throughEventId: 'event-1',
        eventCount: 1,
        sha256: 'a'.repeat(64)
      }
    }
  }
}
async function hookHarness(
  overrides: Partial<RuntimeRecoveryApi> = {},
  failUiRefresh = false
): Promise<{
  read(): HookResult
  navigate(target: RuntimeRecoveryTarget): void
  recovered: RuntimeRecoveryState[]
  summaries: RuntimeSummaryContinuation[]
}> {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
  const slots: Slot[] = []
  const effects: Array<() => void> = []
  let cursor = 0
  let target = original
  const equal = (a: readonly unknown[] | undefined, b: readonly unknown[]): boolean =>
    !!a && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    useState(initial: unknown): [unknown, (value: unknown) => void] {
      const slot = (slots[cursor++] ??= { value: initial })
      return [
        slot.value,
        (value) => {
          slot.value = value
        }
      ]
    },
    useRef(initial: unknown): unknown {
      return (slots[cursor++] ??= { value: { current: initial } }).value
    },
    useCallback(callback: unknown, deps: readonly unknown[]): unknown {
      const index = cursor++
      if (!equal(slots[index]?.deps, deps)) slots[index] = { value: callback, deps }
      return slots[index].value
    },
    useLayoutEffect(setup: () => (() => void) | void, deps: readonly unknown[]): void {
      const index = cursor++
      if (equal(slots[index]?.deps, deps)) return
      const previous = slots[index]
      const slot: Slot = (slots[index] = { deps })
      effects.push(() => {
        previous?.cleanup?.()
        slot.cleanup = setup() ?? undefined
      })
    },
    useEffect(setup: () => (() => void) | void, deps: readonly unknown[]): void {
      const index = cursor++
      if (equal(slots[index]?.deps, deps)) return
      const previous = slots[index]
      const slot: Slot = (slots[index] = { deps })
      effects.push(() => {
        previous?.cleanup?.()
        slot.cleanup = setup() ?? undefined
      })
    }
  }
  const exported = { exports: {} as Record<string, unknown> }
  const source = ts.transpileModule(
    readFileSync('src/renderer/src/features/chat/hooks/useRuntimeRecovery.ts', 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
  ).outputText
  runInNewContext(source, {
    module: exported,
    exports: exported.exports,
    Promise,
    require: (name: string) => {
      if (name === 'react') return react
      if (name === '../lib/runtimeRecoveryState') return { runtimeRecoveryViewKey }
      throw new Error(`Unexpected import: ${name}`)
    }
  })
  const hook = exported.exports
    .useRuntimeRecovery as typeof import('../src/renderer/src/features/chat/hooks/useRuntimeRecovery').useRuntimeRecovery
  const api: RuntimeRecoveryApi = {
    getRuntimeRecoveryState: async (selected) => state(selected),
    resumeRuntimeSession: async () => {
      throw new Error('Unexpected resume')
    },
    continueRuntimeFromSummary: async () => {
      throw new Error('Unexpected summary')
    },
    ...overrides
  }
  const recovered: RuntimeRecoveryState[] = [],
    summaries: RuntimeSummaryContinuation[] = []
  const onRecovered = (result: RuntimeRecoveryState): void => {
    recovered.push(result)
    if (failUiRefresh) throw new Error('App UI refresh failed')
  }
  const onSummaryCreated = (result: RuntimeSummaryContinuation): void => {
    summaries.push(result)
  }
  const read = (): HookResult => {
    cursor = 0
    const result = hook(api, target, onRecovered, onSummaryCreated)
    for (const effect of effects.splice(0)) effect()
    return result
  }
  read()
  await new Promise<void>((resolve) => setImmediate(resolve))
  return {
    read,
    navigate(selected) {
      target = selected
      read()
    },
    recovered,
    summaries
  }
}
test('recovery hook: a late original resume does not refresh, show errors, or change the selected peer', async () => {
  const gate = deferred<RuntimeRecoveryState>()
  const app = await hookHarness({ resumeRuntimeSession: async () => gate.promise })
  const pending = app.read().resume()
  const peer = { ...original, sessionId: 'B', sessionPath: 'phi-session:B' }
  app.navigate(peer)
  await new Promise<void>((resolve) => setImmediate(resolve))
  gate.resolve({ ...state(original), phase: 'connected' })
  await pending
  assert.equal(app.recovered.length, 0)
  assert.equal(app.read().state?.target.sessionId, 'B')
  assert.equal(app.read().error, null)
  assert.equal(app.read().pending, false)
})
test('recovery hook: an owned generation advance keeps the confirmed original recovery callback', async () => {
  const gate = deferred<RuntimeRecoveryState>()
  const app = await hookHarness({ resumeRuntimeSession: async () => gate.promise })
  const pending = app.read().resume()
  const advanced = { ...original, sessionGeneration: 1 }
  app.navigate(advanced)
  gate.resolve({ ...state(advanced), phase: 'connected' })
  await pending
  assert.equal(app.recovered.length, 1)
  assert.equal(app.read().pending, false)
})
test('recovery hook: summary completion can acknowledge its own new Phi but never jumps back from a peer', async () => {
  for (const ownNewPhi of [true, false]) {
    const gate = deferred<RuntimeSummaryContinuation>()
    const app = await hookHarness({ continueRuntimeFromSummary: async () => gate.promise })
    const pending = app.read().continueFromSummary()
    const result: RuntimeSummaryContinuation = {
      path: 'phi-session:new',
      phiSessionId: 'new',
      projectId: original.projectId,
      sessionGeneration: 1,
      sourceSessionId: original.sessionId,
      connected: false
    }
    app.navigate({
      ...original,
      sessionId: ownNewPhi ? 'new' : 'peer',
      sessionPath: ownNewPhi ? result.path : 'phi-session:peer',
      sessionGeneration: 1
    })
    gate.resolve(result)
    await pending
    assert.equal(app.summaries.length, ownNewPhi ? 1 : 0)
  }
})

test('recovery hook: a newer same-Phi event while resume is pending is reread with its latest generation', async () => {
  const reply = deferred<RuntimeRecoveryState>()
  let notify: Parameters<NonNullable<RuntimeRecoveryApi['onSessionChanged']>>[0] | undefined
  const reads: RuntimeRecoveryTarget[] = []
  let latest = state(original)
  const app = await hookHarness({
    getRuntimeRecoveryState: async (target) => {
      reads.push(target)
      return latest
    },
    resumeRuntimeSession: async () => reply.promise,
    onSessionChanged: (callback) => {
      notify = callback
      return () => undefined
    }
  })
  const running = app.read().resume()
  latest = {
    ...state({ ...original, sessionGeneration: 2 }),
    message: 'Newer disconnect after accepted resume'
  }
  notify!({ phiSessionId: original.sessionId, projectId: original.projectId, sessionGeneration: 2 })
  app.read()
  reply.resolve({
    ...state({ ...original, sessionGeneration: 1 }),
    phase: 'connected',
    canResume: false
  })
  await running
  assert.equal(app.read().state?.phase, 'recovery-required')
  assert.equal(app.read().state?.message, latest.message)
  assert.equal(reads.length, 2)
  assert.equal(reads.at(-1)?.sessionGeneration, 2)
  assert.equal(app.read().pending, false)
})

test('recovery hook: a queued connected state read preserves a failed App message refresh', async () => {
  const reply = deferred<RuntimeRecoveryState>()
  let notify: Parameters<NonNullable<RuntimeRecoveryApi['onSessionChanged']>>[0] | undefined
  const connected: RuntimeRecoveryState = {
    ...state({ ...original, sessionGeneration: 1 }),
    phase: 'connected',
    canResume: false
  }
  const app = await hookHarness(
    {
      getRuntimeRecoveryState: async () => connected,
      resumeRuntimeSession: async () => reply.promise,
      onSessionChanged: (callback) => {
        notify = callback
        return () => undefined
      }
    },
    true
  )
  const running = app.read().resume()
  notify!({ phiSessionId: original.sessionId, projectId: original.projectId, sessionGeneration: 1 })
  reply.resolve(connected)
  await running
  assert.equal(app.read().state?.phase, 'connected')
  assert.match(app.read().error ?? '', /原会话已恢复，但界面刷新未完成/)
  await app.read().refresh()
  assert.match(app.read().error ?? '', /界面刷新未完成/)
  app.navigate({ ...original, sessionId: 'peer', sessionPath: 'phi-session:peer' })
  assert.equal(app.read().error, null)
})
