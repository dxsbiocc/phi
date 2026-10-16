import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { ModelOption, ThinkingLevel } from '../src/renderer/src/types'
import type { ModelSelectionState } from '../src/renderer/src/useModelSelection'
import { sessionStateKey } from '../src/renderer/src/stores/sessionStore'

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

const models: ModelOption[] = ['first', 'second', 'third'].map((modelId) => ({
  providerId: 'fixture',
  modelId,
  name: modelId,
  thinkingLevels: ['low', 'medium', 'high']
}))

type Api = Pick<
  Window['api'],
  'listModels' | 'getSelectedModel' | 'selectModel' | 'selectThinkingLevel'
> & { getThinkingLevel: () => Promise<ThinkingLevel | undefined> }
type Slot =
  | { kind: 'state'; value: unknown; set: (value: unknown) => void }
  | { kind: 'ref'; value: { current: unknown } }
  | { kind: 'memo'; value: unknown; deps: readonly unknown[] }
  | { kind: 'effect'; deps: readonly unknown[] }

function appSessionGetter(context: Record<string, unknown>): () => string | number {
  const syntax = ts.createSourceFile(
    'App.tsx',
    readFileSync('src/renderer/src/App.tsx', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const declarations = new Map<string, ts.Expression>()
  let getterName: string | undefined
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.set(node.name.text, node.initializer)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useModelSelection' &&
      ts.isIdentifier(node.arguments[2])
    ) {
      getterName = node.arguments[2].text
    }
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  const initializer = getterName && declarations.get(getterName)
  if (!initializer) throw new Error('App must supply the control session getter')
  const code = ts.transpileModule(`(${initializer.getText(syntax)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return runInNewContext(code, {
    useCallback: (callback: unknown) => callback,
    sessionStateKey,
    ...context
  }) as () => string | number
}

/** Run the whole production hook, including its deferred IPC continuations. */
async function harness(overrides: Partial<Api> = {}): Promise<{
  read: () => ModelSelectionState
  navigate: (model: ModelOption, level: ThinkingLevel) => void
  failNavigation: () => void
  replaceActiveSession: (model: ModelOption, level: ThinkingLevel) => void
  errors: Array<{ error: unknown; fallback: string }>
}> {
  const slots: Slot[] = []
  let cursor = 0
  const sessionRequestRef = { current: 0 }
  let activeSession = 0
  const getState = (): {
    activePhiSessionId: string
    activeSessionPath: string
    activeCwd: string
    activeSessionGeneration: number
  } => ({
    activePhiSessionId: `session-${activeSession}`,
    activeSessionPath: `/session-${activeSession}.jsonl`,
    activeCwd: '/fixture',
    activeSessionGeneration: activeSession
  })
  const effects: Array<() => void> = []
  const errors: Array<{ error: unknown; fallback: string }> = []
  const sameDeps = (left: readonly unknown[], right: readonly unknown[]): boolean =>
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  function memo<T>(create: () => T, deps: readonly unknown[]): T {
    const index = cursor++
    const previous = slots[index]
    if (previous?.kind === 'memo' && sameDeps(previous.deps, deps)) return previous.value as T
    const value = create()
    slots[index] = { kind: 'memo', value, deps }
    return value
  }
  const react = {
    useState<T>(initial: T): [T, (value: T | ((current: T) => T)) => void] {
      const index = cursor++
      if (!slots[index]) {
        const slot: Extract<Slot, { kind: 'state' }> = {
          kind: 'state',
          value: initial,
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
    useCallback<T>(callback: T, deps: readonly unknown[]): T {
      return memo(() => callback, deps)
    },
    useMemo: memo,
    useEffect(setup: () => void, deps: readonly unknown[]): void {
      const index = cursor++
      const previous = slots[index]
      if (previous?.kind === 'effect' && sameDeps(previous.deps, deps)) return
      slots[index] = { kind: 'effect', deps }
      effects.push(setup)
    }
  }
  let selected: { providerId: string; modelId: string } | null = {
    providerId: 'fixture',
    modelId: 'first'
  }
  let thinkingLevel: ThinkingLevel = 'high'
  const api: Api = {
    listModels: async () => models,
    getSelectedModel: overrides.getSelectedModel ?? (async () => selected),
    getThinkingLevel: overrides.getThinkingLevel ?? (async () => thinkingLevel),
    ...overrides,
    selectModel: async (providerId, modelId) => {
      await overrides.selectModel?.(providerId, modelId)
      selected = providerId !== null && modelId !== null ? { providerId, modelId } : null
    },
    selectThinkingLevel: async (level) => {
      await overrides.selectThinkingLevel?.(level)
      thinkingLevel = level
    }
  }
  const module = { exports: {} as Record<string, unknown> }
  const source = ts.transpileModule(readFileSync('src/renderer/src/useModelSelection.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  runInNewContext(source, {
    module,
    exports: module.exports,
    require(name: string): unknown {
      if (name === 'react') return react
      throw new Error(`Unexpected runtime import: ${name}`)
    },
    window: { api },
    Promise
  })
  const hook = module.exports.useModelSelection as (
    providers: unknown[],
    onError: (error: unknown, fallback: string) => void,
    getSessionKey: () => string | number
  ) => ModelSelectionState
  const providers = [{ providerId: 'fixture', configured: true }]
  const onError = (error: unknown, fallback: string): void => {
    errors.push({ error, fallback })
  }
  const getSessionKey = appSessionGetter({ sessionRequestRef, useSessionStore: { getState } })
  const read = (): ModelSelectionState => {
    cursor = 0
    const state = hook(providers, onError, getSessionKey)
    for (const effect of effects.splice(0)) effect()
    return state
  }
  read()
  await new Promise<void>((resolve) => setImmediate(resolve))
  return {
    read,
    navigate(model, level): void {
      sessionRequestRef.current += 1
      activeSession += 1
      const state = read()
      state.setSelectedModel(model)
      state.setThinkingLevel(level)
    },
    failNavigation(): void {
      sessionRequestRef.current += 1
      read()
    },
    replaceActiveSession(model, level): void {
      activeSession += 1
      const state = read()
      state.setSelectedModel(model)
      state.setThinkingLevel(level)
    },
    errors
  }
}

test('a previous session model failure cannot change the newly opened session or show an error', async () => {
  const pending = deferred<void>()
  const f = await harness({ selectModel: () => pending.promise })
  const selection = f.read().onSelectModel(models[1])
  f.navigate(models[2], 'low')
  pending.reject(new Error('Previous session was retired'))
  await selection
  assert.equal(f.read().selectedModel, models[2])
  assert.equal(f.read().thinkingLevel, 'low')
  assert.equal(f.errors.length, 0)
})

test('a previous session thinking failure cannot change the newly opened session or show an error', async () => {
  const pending = deferred<void>()
  const f = await harness({ selectThinkingLevel: () => pending.promise })
  const selection = f.read().onSelectThinkingLevel('medium')
  f.navigate(models[2], 'low')
  pending.reject(new Error('Previous session was retired'))
  await selection
  assert.equal(f.read().thinkingLevel, 'low')
  assert.equal(f.errors.length, 0)
})

test('an older model failure cannot roll back a newer selection in the same session', async () => {
  const older = deferred<void>()
  const newer = deferred<void>()
  const f = await harness({
    selectModel: (_provider, model) => (model === 'second' ? older.promise : newer.promise)
  })
  const first = f.read().onSelectModel(models[1])
  const second = f.read().onSelectModel(models[2])
  older.reject(new Error('Older model failed'))
  await first
  assert.equal(f.read().selectedModel, models[2])
  newer.resolve()
  await second
  assert.equal(f.read().selectedModel, models[2])
  assert.equal(f.errors.length, 0)
})

test('an older thinking failure cannot roll back a newer selection in the same session', async () => {
  const older = deferred<void>()
  const newer = deferred<void>()
  const f = await harness({
    selectThinkingLevel: (level) => (level === 'medium' ? older.promise : newer.promise)
  })
  const first = f.read().onSelectThinkingLevel('medium')
  const second = f.read().onSelectThinkingLevel('low')
  older.reject(new Error('Older thinking failed'))
  await first
  assert.equal(f.read().thinkingLevel, 'low')
  newer.resolve()
  await second
  assert.equal(f.read().thinkingLevel, 'low')
  assert.equal(f.errors.length, 0)
})

test('a late model failure preserves a newer already confirmed selection', async () => {
  const older = deferred<void>()
  const f = await harness({
    selectModel: (_provider, model) => (model === 'second' ? older.promise : Promise.resolve())
  })
  const first = f.read().onSelectModel(models[1])
  await f.read().onSelectModel(models[2])
  older.reject(new Error('Older model failed'))
  await first
  assert.equal(f.read().selectedModel, models[2])
  assert.equal(f.errors.length, 0)
})

test('a late thinking failure preserves a newer already confirmed selection', async () => {
  const older = deferred<void>()
  const f = await harness({
    selectThinkingLevel: (level) => (level === 'medium' ? older.promise : Promise.resolve())
  })
  const first = f.read().onSelectThinkingLevel('medium')
  await f.read().onSelectThinkingLevel('low')
  older.reject(new Error('Older thinking failed'))
  await first
  assert.equal(f.read().thinkingLevel, 'low')
  assert.equal(f.errors.length, 0)
})

test('a current model failure restores the previous selection and reports the error', async () => {
  const failure = new Error('Model unavailable')
  const f = await harness({
    selectModel: async () => {
      throw failure
    }
  })
  await f.read().onSelectModel(models[1])
  assert.equal(f.read().selectedModel, models[0])
  assert.deepEqual(f.errors, [{ error: failure, fallback: '切换模型失败' }])
})

test('a current thinking failure restores the previous level and reports the error', async () => {
  const failure = new Error('Thinking level unavailable')
  const f = await harness({
    selectThinkingLevel: async () => {
      throw failure
    }
  })
  await f.read().onSelectThinkingLevel('low')
  assert.equal(f.read().thinkingLevel, 'high')
  assert.deepEqual(f.errors, [{ error: failure, fallback: '切换思考等级失败' }])
})

test('successful selections remain selected and model success refreshes the normalized thinking level', async () => {
  let effectiveLevel: ThinkingLevel = 'high'
  const f = await harness({
    getThinkingLevel: async () => effectiveLevel,
    selectModel: async () => {
      effectiveLevel = 'medium'
    },
    selectThinkingLevel: async (level) => {
      effectiveLevel = level
    }
  })
  await f.read().onSelectModel(models[1])
  assert.equal(f.read().selectedModel, models[1])
  assert.equal(f.read().thinkingLevel, 'medium')
  await f.read().onSelectThinkingLevel('low')
  assert.equal(f.read().thinkingLevel, 'low')
  assert.equal(f.errors.length, 0)
})

test('failure to refresh thinking after a successful model switch does not undo the switch', async () => {
  let switched = false
  const f = await harness({
    selectModel: async () => {
      switched = true
    },
    getThinkingLevel: async () => {
      if (switched) throw new Error('Refresh failed')
      return 'high'
    }
  })
  await f.read().onSelectModel(models[1])
  assert.equal(switched, true)
  assert.equal(f.read().selectedModel, models[1])
  assert.equal(f.errors.length, 0)
})

test('a delayed model-success refresh cannot overwrite a newer thinking selection', async () => {
  const refresh = deferred<ThinkingLevel>()
  const refreshStarted = deferred<void>()
  let switched = false
  let held = false
  const f = await harness({
    selectModel: async () => {
      switched = true
    },
    getThinkingLevel: () => {
      if (!switched) return Promise.resolve('high')
      if (held) return Promise.resolve('low')
      held = true
      refreshStarted.resolve()
      return refresh.promise
    }
  })
  const selection = f.read().onSelectModel(models[1])
  await refreshStarted.promise
  await f.read().onSelectThinkingLevel('low')
  refresh.resolve('medium')
  await selection
  assert.equal(f.read().selectedModel, models[1])
  assert.equal(f.read().thinkingLevel, 'low')
  assert.equal(f.errors.length, 0)
})

test('a delayed model-success refresh cannot overwrite the newly opened session', async () => {
  const refresh = deferred<ThinkingLevel>()
  const refreshStarted = deferred<void>()
  let switched = false
  const f = await harness({
    selectModel: async () => {
      switched = true
    },
    getThinkingLevel: () => {
      if (!switched) return Promise.resolve('high')
      refreshStarted.resolve()
      return refresh.promise
    }
  })
  const selection = f.read().onSelectModel(models[1])
  await refreshStarted.promise
  f.navigate(models[2], 'low')
  refresh.resolve('medium')
  await selection
  assert.equal(f.read().selectedModel, models[2])
  assert.equal(f.read().thinkingLevel, 'low')
  assert.equal(f.errors.length, 0)
})

test('an older pending model success is reconciled after a newer busy rejection', async () => {
  const pending = deferred<void>()
  const f = await harness({
    selectModel: (_provider, model) => {
      if (model === 'second') return pending.promise
      return Promise.reject(new Error('Another control update is pending'))
    }
  })
  const first = f.read().onSelectModel(models[1])
  await f.read().onSelectModel(models[2])
  assert.equal(f.read().selectedModel, models[0])
  pending.resolve()
  await first
  assert.equal(f.read().selectedModel, models[1])
  assert.equal(f.errors.length, 1)
})

test('an older pending thinking success is reconciled after a newer busy rejection', async () => {
  const pending = deferred<void>()
  const f = await harness({
    selectThinkingLevel: (level) => {
      if (level === 'medium') return pending.promise
      return Promise.reject(new Error('Another control update is pending'))
    }
  })
  const first = f.read().onSelectThinkingLevel('medium')
  await f.read().onSelectThinkingLevel('low')
  assert.equal(f.read().thinkingLevel, 'high')
  pending.resolve()
  await first
  assert.equal(f.read().thinkingLevel, 'medium')
  assert.equal(f.errors.length, 1)
})

test('a pending model success also reconciles thinking after a newer thinking busy rejection', async () => {
  const pending = deferred<void>()
  let level: ThinkingLevel = 'high'
  const f = await harness({
    selectModel: async () => {
      await pending.promise
      level = 'medium'
    },
    selectThinkingLevel: async () => {
      throw new Error('Model update is pending')
    },
    getThinkingLevel: async () => level
  })
  const modelSelection = f.read().onSelectModel(models[1])
  await f.read().onSelectThinkingLevel('low')
  pending.resolve()
  await modelSelection
  assert.equal(f.read().selectedModel, models[1])
  assert.equal(f.read().thinkingLevel, 'medium')
  assert.equal(f.errors.length, 1)
})

test('two rejected model requests and an unavailable refresh restore the confirmed baseline', async () => {
  const older = deferred<void>()
  const newer = deferred<void>()
  let refreshing = false
  const f = await harness({
    selectModel: (_provider, model) => (model === 'second' ? older.promise : newer.promise),
    getSelectedModel: async () => {
      if (refreshing) throw new Error('State unavailable')
      return { providerId: 'fixture', modelId: 'first' }
    }
  })
  const first = f.read().onSelectModel(models[1])
  const second = f.read().onSelectModel(models[2])
  older.reject(new Error('Older rejected'))
  await first
  refreshing = true
  newer.reject(new Error('Newer rejected'))
  await second
  assert.equal(f.read().selectedModel, models[0])
  assert.equal(f.errors.length, 1)
})

test('a late initial control load does not overwrite a session opened during startup', async () => {
  const available = deferred<ModelOption[]>()
  const f = await harness({ listModels: () => available.promise })
  f.navigate(models[2], 'low')
  available.resolve(models)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(f.read().selectedModel, models[2])
  assert.equal(f.read().thinkingLevel, 'low')
  assert.equal(f.read().availableModels.length, models.length)
  assert.equal(f.read().isModelStateReady, true)
})

test('an earlier accepted model survives a later busy rejection even if the final refresh is unavailable', async () => {
  const pending = deferred<void>()
  let refreshing = false
  const f = await harness({
    selectModel: (_provider, model) => {
      if (model === 'second') return pending.promise
      return Promise.reject(new Error('Another control update is pending'))
    },
    getSelectedModel: async () => {
      if (refreshing) throw new Error('State unavailable')
      return { providerId: 'fixture', modelId: 'first' }
    }
  })
  const first = f.read().onSelectModel(models[1])
  await f.read().onSelectModel(models[2])
  refreshing = true
  pending.resolve()
  await first
  assert.equal(f.read().selectedModel, models[1])
  assert.equal(f.errors.length, 1)
})

test('a failed navigation attempt preserves rollback and errors for the still active model request', async () => {
  const pending = deferred<void>()
  const f = await harness({ selectModel: () => pending.promise })
  const selection = f.read().onSelectModel(models[1])
  f.failNavigation()
  pending.reject(new Error('Current model rejected'))
  await selection
  assert.equal(f.read().selectedModel, models[0])
  assert.equal(f.errors.length, 1)
})

test('a failed navigation attempt preserves rollback and errors for the still active thinking request', async () => {
  const pending = deferred<void>()
  const f = await harness({ selectThinkingLevel: () => pending.promise })
  const selection = f.read().onSelectThinkingLevel('low')
  f.failNavigation()
  pending.reject(new Error('Current thinking rejected'))
  await selection
  assert.equal(f.read().thinkingLevel, 'high')
  assert.equal(f.errors.length, 1)
})

test('deleting the active session invalidates its pending model failure without a navigation attempt', async () => {
  const pending = deferred<void>()
  const f = await harness({ selectModel: () => pending.promise })
  const selection = f.read().onSelectModel(models[1])
  f.replaceActiveSession(models[2], 'low')
  pending.reject(new Error('Deleted session rejected'))
  await selection
  assert.equal(f.read().selectedModel, models[2])
  assert.equal(f.read().thinkingLevel, 'low')
  assert.equal(f.errors.length, 0)
})

test('deleting the active session invalidates its pending thinking failure without a navigation attempt', async () => {
  const pending = deferred<void>()
  const f = await harness({ selectThinkingLevel: () => pending.promise })
  const selection = f.read().onSelectThinkingLevel('medium')
  f.replaceActiveSession(models[2], 'low')
  pending.reject(new Error('Deleted session rejected'))
  await selection
  assert.equal(f.read().thinkingLevel, 'low')
  assert.equal(f.errors.length, 0)
})

test('a late older model success cannot replace a newer confirmed fallback when state refresh fails', async () => {
  const older = deferred<void>()
  let backendModel = 'first'
  let refreshing = false
  const f = await harness({
    selectModel: (_provider, model) => {
      assert.ok(model)
      backendModel = model
      return model === 'second' ? older.promise : Promise.resolve()
    },
    getSelectedModel: async () => {
      if (refreshing) throw new Error('State unavailable')
      return { providerId: 'fixture', modelId: backendModel }
    }
  })
  const first = f.read().onSelectModel(models[1])
  await f.read().onSelectModel(models[2])
  refreshing = true
  older.resolve()
  await first
  assert.equal(backendModel, 'third')
  assert.equal(f.read().selectedModel, models[2])
  assert.equal(f.errors.length, 0)
})

test('a late older thinking success cannot replace a newer confirmed fallback when state refresh fails', async () => {
  const older = deferred<void>()
  let backendLevel: ThinkingLevel = 'high'
  let refreshing = false
  const f = await harness({
    selectThinkingLevel: (level) => {
      backendLevel = level
      return level === 'medium' ? older.promise : Promise.resolve()
    },
    getThinkingLevel: async () => {
      if (refreshing) throw new Error('State unavailable')
      return backendLevel
    }
  })
  const first = f.read().onSelectThinkingLevel('medium')
  await f.read().onSelectThinkingLevel('low')
  refreshing = true
  older.resolve()
  await first
  assert.equal(backendLevel, 'low')
  assert.equal(f.read().thinkingLevel, 'low')
  assert.equal(f.errors.length, 0)
})

test('a nonreasoning model succeeds while undefined thinking reads preserve a valid UI level', async () => {
  const nonreasoning = { ...models[1], thinkingLevels: [] }
  const f = await harness({
    listModels: async () => [models[0], nonreasoning, models[2]],
    getThinkingLevel: async () => undefined
  })
  const initialLevel = f.read().thinkingLevel
  await f.read().onSelectModel(nonreasoning)
  assert.equal(f.read().selectedModel, nonreasoning)
  assert.equal(initialLevel, 'high')
  assert.equal(f.read().thinkingLevel, 'high')
  assert.equal(f.errors.length, 0)
})

test('selecting automatic persists null through the model IPC and reconciliation', async () => {
  const calls: unknown[][] = []
  const f = await harness({
    selectModel: async (...args) => {
      calls.push(args)
    }
  })
  await f.read().onSelectModel(null)
  assert.deepEqual(calls, [[null, null]])
  assert.equal(f.read().selectedModel, null)
  assert.equal(f.errors.length, 0)
})

test('a rejected automatic selection restores the confirmed fixed model', async () => {
  const f = await harness({
    selectModel: async () => {
      throw new Error('Busy')
    }
  })
  await f.read().onSelectModel(null)
  assert.equal(f.read().selectedModel, models[0])
  assert.equal(f.errors.length, 1)
})

test('a fixed selection following automatic wins while its confirmation settles', async () => {
  const automatic = deferred<void>()
  const f = await harness({
    selectModel: (providerId) => (providerId === null ? automatic.promise : Promise.resolve())
  })
  const pending = f.read().onSelectModel(null)
  await f.read().onSelectModel(models[2])
  automatic.reject(new Error('Superseded automatic selection'))
  await pending
  assert.equal(f.read().selectedModel, models[2])
  assert.equal(f.errors.length, 0)
})

test('an unavailable saved model remains visible instead of displaying automatic selection', async () => {
  const f = await harness({
    getSelectedModel: async () => ({ providerId: 'missing', modelId: 'saved-model' })
  })
  const selected = f.read().selectedModel
  assert.equal(selected?.providerId, 'missing')
  assert.equal(selected?.modelId, 'saved-model')
  assert.equal(selected?.name, 'missing/saved-model（不可用）')
  assert.equal(selected?.thinkingLevels.length, 0)
  assert.equal(
    f.read().availableModels.some((model) => model.providerId === 'missing'),
    false
  )
})
