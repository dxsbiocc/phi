import * as i18n from '../../src/renderer/src/lib/i18n'
import { pluginCopy } from '../../src/renderer/src/features/phi-plugin/lib/pluginCopy'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { errorMessage } from '../../src/shared/errorCodes'
import * as phiPluginsLib from '../../src/renderer/src/features/phi-plugin/lib/phiPlugins'
import { retainSelectedCatalogId } from '../../src/renderer/src/lib/catalogSelection'

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

export function deferred<T>(): Deferred<T> {
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
export function hookHarness<State>(
  path: string,
  name: string,
  api: Record<string, unknown>,
  args: unknown[] = [],
  imports: Record<string, unknown> = {}
): {
  read: () => State
  runTimers: () => void
  restartEffects: () => void
  unmount: () => void
  writes: () => number
} {
  const slots: Slot[] = []
  let cursor = 0
  let timerId = 0
  let stateWrites = 0
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
            stateWrites += 1
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
    useMemo<T>(factory: () => T, deps: readonly unknown[]): T {
      const index = cursor++
      const slot = slots[index]
      if (slot?.kind === 'callback' && sameDeps(slot.deps, deps)) return slot.value as T
      const value = factory()
      slots[index] = { kind: 'callback', value, deps }
      return value
    },
    useReducer<State, Action>(
      reducer: (state: State, action: Action) => State,
      initial: State
    ): [State, (action: Action) => void] {
      const [state, setState] = react.useState(initial)
      const dispatch = react.useCallback(
        (action: Action) => setState((current) => reducer(current, action)),
        [setState]
      )
      return [state, dispatch]
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
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX
    }
  }).outputText
  runInNewContext(source, {
    module,
    exports: module.exports,
    require(specifier: string): unknown {
      if (specifier === 'react') return react
      if (specifier.endsWith('/shared/errorCodes')) return { errorMessage }
      // The harness schedules renders explicitly; read the actual locale snapshot each time.
      if (specifier.endsWith('/i18n')) return { ...i18n, useUiLanguage: i18n.getUiLanguage }
      if (Object.hasOwn(imports, specifier)) return imports[specifier]
      if (specifier.endsWith('/catalogSelection')) return { retainSelectedCatalogId }
      if (specifier.endsWith('/pluginCopy')) return { pluginCopy }
      if (specifier === '../lib/phiPlugins') return phiPluginsLib
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
    },
    unmount(): void {
      for (const slot of slots) {
        if (slot.kind !== 'effect') continue
        slot.cleanup?.()
        slot.cleanup = undefined
      }
      pendingEffects.splice(0)
      timers.clear()
    },
    writes: () => stateWrites
  }
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
