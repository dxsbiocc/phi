import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'

import type { PlanRunState } from '../src/shared/planRunTypes'
import {
  usePlanRuns,
  type PlanRunsController
} from '../src/renderer/src/features/plan/hooks/usePlanRuns'

type HookDispatcher = Record<string, (...args: never[]) => unknown>
type HookInternals = {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
    H: HookDispatcher | null
  }
}

const internals = (React as unknown as HookInternals)
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

function sameDeps(
  left: readonly unknown[] | undefined,
  right: readonly unknown[] | undefined
): boolean {
  if (!left || !right || left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

type Effect = {
  slot: number
  deps: readonly unknown[] | undefined
  run: () => void | (() => void)
}

/**
 * Runs the hook outside a DOM with React's dispatcher. The plan hook only uses state,
 * refs, memo/callback, effects, and a never-mutated external store, so this keeps the
 * regression test on the real action wiring without adding a renderer test dependency.
 */
function createHookRuntime(): {
  render: (hook: () => void) => void
  settle: (hook: () => void) => Promise<void>
} {
  const slots: Array<Record<string, unknown> | undefined> = []
  const effectDeps: Array<readonly unknown[] | undefined> = []
  const cleanups = new Map<number, () => void>()
  const pendingEffects: Effect[] = []
  let index = 0
  let dirty = false

  const dispatcher: HookDispatcher = {
    useState(initial: unknown) {
      const slot = index++
      if (!slots[slot]) {
        slots[slot] = {
          value: typeof initial === 'function' ? (initial as () => unknown)() : initial
        }
      }
      const state = slots[slot]!
      state.set ??= (next: unknown): void => {
        const value =
          typeof next === 'function' ? (next as (prev: unknown) => unknown)(state.value) : next
        if (Object.is(value, state.value)) return
        state.value = value
        dirty = true
      }
      return [state.value, state.set]
    },
    useRef(initial: unknown) {
      const slot = index++
      if (!slots[slot]) slots[slot] = { current: initial }
      return slots[slot]
    },
    useMemo(factory: () => unknown, deps?: readonly unknown[]) {
      const slot = index++
      if (!slots[slot] || !sameDeps(slots[slot]!.deps as readonly unknown[] | undefined, deps)) {
        slots[slot] = { deps, value: factory() }
      }
      return slots[slot]!.value
    },
    useCallback(callback: () => unknown, deps?: readonly unknown[]) {
      const slot = index++
      if (!slots[slot] || !sameDeps(slots[slot]!.deps as readonly unknown[] | undefined, deps)) {
        slots[slot] = { deps, value: callback }
      }
      return slots[slot]!.value
    },
    useEffect(run: () => void | (() => void), deps?: readonly unknown[]) {
      pendingEffects.push({ slot: index++, deps, run })
    },
    useLayoutEffect(run: () => void | (() => void), deps?: readonly unknown[]) {
      pendingEffects.push({ slot: index++, deps, run })
    },
    useSyncExternalStore(_subscribe: () => () => void, getSnapshot: () => unknown) {
      const slot = index++
      if (!slots[slot]) slots[slot] = { value: getSnapshot() }
      return slots[slot]!.value
    }
  }

  const render = (hook: () => void): void => {
    index = 0
    internals.H = dispatcher
    try {
      hook()
    } finally {
      internals.H = null
    }
  }

  const settle = async (hook: () => void): Promise<void> => {
    for (let round = 0; round < 50; round += 1) {
      const effects = pendingEffects.splice(0)
      for (const effect of effects) {
        if (sameDeps(effectDeps[effect.slot] as readonly unknown[] | undefined, effect.deps)) {
          continue
        }
        cleanups.get(effect.slot)?.()
        const cleanup = effect.run()
        cleanups.set(effect.slot, typeof cleanup === 'function' ? cleanup : () => undefined)
        effectDeps[effect.slot] = effect.deps
      }
      await Promise.resolve()
      await new Promise((resolve) => setImmediate(resolve))
      if (!dirty && pendingEffects.length === 0) return
      if (dirty) {
        dirty = false
        render(hook)
      }
    }
    throw new Error('The plan run hook did not settle')
  }

  return { render, settle }
}

function pausedRun(): PlanRunState {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    status: 'paused',
    pause: { reason: 'interrupted', stepId: 'step-b' },
    replans: 0,
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:05.000Z',
    spec: {
      version: 1,
      goal: 'Ship it',
      steps: [
        {
          id: 'step-a',
          title: 'A',
          instructions: 'A',
          acceptance: 'A',
          access: 'read',
          dependsOn: []
        },
        {
          id: 'step-b',
          title: 'B',
          instructions: 'B',
          acceptance: 'B',
          access: 'read',
          dependsOn: []
        }
      ]
    },
    steps: {
      'step-a': { status: 'done', attempts: 1 },
      'step-b': { status: 'interrupted', attempts: 1 }
    }
  }
}

function planApi(
  run: PlanRunState | null,
  calls: Array<[string, string, string]>
): Parameters<typeof usePlanRuns>[0] {
  return {
    onAgentEvent: () => () => undefined,
    listPlanRuns: async () => (run ? [run] : []),
    getPlanRun: async () => run,
    pausePlanRun: async () => run!,
    resumePlanRun: async () => run!,
    stopPlanRun: async () => run!,
    retryPlanRunStep: async (sessionId: string, runId: string, stepId: string) => {
      calls.push([sessionId, runId, stepId])
      return { ...run!, status: 'running' as const, pause: undefined }
    },
    skipPlanRunStep: async () => run!,
    requestPlanRunReplan: async () => ({ requestId: 'request-1', runId: 'run-1', prompt: 'x' }),
    cancelPlanRunReplan: async () => undefined,
    getPendingPlanRunReplan: async () => null
  }
}

test('a restored paused plan retries through the action captured before its run loaded', async (): Promise<void> => {
  const calls: Array<[string, string, string]> = []
  const run = pausedRun()
  const runtime = createHookRuntime()
  const api = planApi(run, calls)
  const onReplanPrompt = async (): Promise<boolean> => true
  let controller!: PlanRunsController
  const usePlanRunsHarness = (): void => {
    controller = usePlanRuns(api, 'session-1', onReplanPrompt)
  }

  runtime.render(usePlanRunsHarness)
  const retryBeforeRunLoaded = controller.retryStep
  await runtime.settle(usePlanRunsHarness)
  assert.equal(controller.run?.id, 'run-1')

  await retryBeforeRunLoaded('step-b')

  assert.deepEqual(calls, [['session-1', 'run-1', 'step-b']])
})

test('retry reports an error instead of silently doing nothing without a run', async (): Promise<void> => {
  const calls: Array<[string, string, string]> = []
  const runtime = createHookRuntime()
  const api = planApi(null, calls)
  const onReplanPrompt = async (): Promise<boolean> => true
  let controller!: PlanRunsController
  const usePlanRunsHarness = (): void => {
    controller = usePlanRuns(api, 'session-1', onReplanPrompt)
  }

  runtime.render(usePlanRunsHarness)
  await runtime.settle(usePlanRunsHarness)
  assert.equal(controller.run, null)

  await controller.retryStep('step-b')
  await runtime.settle(usePlanRunsHarness)

  assert.deepEqual(calls, [])
  assert.ok(controller.error)
})
