import type { SessionRun } from '../../../session/session-runner-registry'
import { MAX_EXECUTION_CALLS } from '../../phi-extension/lib/rpc-execution-protocol'
import type { RpcVerifiedTaskOrigin } from '../execution-authority'
import type { RpcChildStarted } from './run-registry'
import type { RpcFrame } from '../types'
import { withRemoteSignal } from '../history-pager'
import type { RpcTaskSettlement } from '../../phi-extension/lib/rpc-task-settlement-protocol'

interface ParentTask {
  readonly parent: SessionRun
  readonly toolCallId: string
  readonly digest: string
  readonly controlSequence: number
  readonly nativeIds: Set<string>
  declaredTaskCount?: number
  expectedTaskCount?: number
  dispatchSealed: boolean
  launchAttested: boolean
  conflict?: boolean
  endedWithoutStart?: boolean
  noSpawn?: boolean
}
export interface ProductionChildLedgerOptions {
  readonly phiSessionId: string
  readonly generation: number
  /** Must return the application's exact registered SessionRun, not prompt compatibility data. */
  readonly currentParentRun: () => SessionRun | undefined
  readonly onStop: (parent: SessionRun) => void
  /** Only a registry-confirmed terminal permits a later parent turn to reuse a provider outer ID. */
  readonly isNativeTerminal?: (nativeId: string, parentRunId: string) => boolean
  readonly allowBackground?: boolean
  readonly maxChildrenPerTask?: number
  readonly requireDispatchSeal?: boolean
}
export interface VerifiedTaskLaunchExpectation {
  readonly parentRunId: string
  readonly toolCallId: string
  readonly controlSequence: number
  readonly inputDigest: string
  readonly declaredTaskCount: number
  readonly expectedTaskCount: number
  readonly dispatchSealed: boolean
}

/** Only the execution authority's verified origin callback admits a parent task. */
export class ProductionChildLedger {
  private readonly tasks = new Map<string, ParentTask>()
  private readonly parents = new Map<string, { run: SessionRun; detach: () => void }>()
  private readonly native = new Map<string, ParentTask>()
  private readonly changed = new Set<() => void>()
  private readonly retirement = new Set<string>()
  private readonly pendingLaunches = new Map<string, VerifiedTaskLaunchExpectation>()
  private readonly maximum: number
  private disposed = false

  constructor(private readonly options: ProductionChildLedgerOptions) {
    this.options = Object.freeze({ ...options })
    this.maximum = options.maxChildrenPerTask ?? 1
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > 32)
      throw new Error('Invalid task child capacity')
  }

  remember({ origin, run }: RpcVerifiedTaskOrigin): void {
    const parent = this.options.currentParentRun()
    const previous = this.tasks.get(origin.toolCallId)
    const reusable =
      !!parent &&
      !!previous?.nativeIds.size &&
      !previous.noSpawn &&
      previous.parent.runId !== parent.runId &&
      [...previous.nativeIds].every(
        (id) => this.options.isNativeTerminal?.(id, previous.parent.runId) === true
      )
    if (
      this.disposed ||
      origin.toolName !== 'task' ||
      origin.phiSessionId !== this.options.phiSessionId ||
      origin.generation !== this.options.generation ||
      origin.runId !== run.id ||
      run.signal.aborted ||
      !parent ||
      parent.sessionId !== this.options.phiSessionId ||
      parent.runId !== run.id ||
      parent.signal.aborted ||
      (previous !== undefined && !reusable) ||
      this.tasks.size >= MAX_EXECUTION_CALLS
    )
      throw new Error('Task origin lacks its exact registered Phi parent run')
    const known = this.parents.get(parent.runId)
    if (known && known.run !== parent) throw new Error('Phi parent run identity was replaced')
    if (!known) {
      if (this.parents.size >= MAX_EXECUTION_CALLS)
        throw new Error('Phi parent ledger capacity exhausted')
      const stop = (): void => this.options.onStop(parent)
      parent.signal.addEventListener('abort', stop, { once: true })
      this.parents.set(parent.runId, {
        run: parent,
        detach: () => parent.signal.removeEventListener('abort', stop)
      })
    }
    this.tasks.set(origin.toolCallId, {
      parent,
      toolCallId: origin.toolCallId,
      digest: origin.inputDigest,
      controlSequence: origin.sequence,
      nativeIds: new Set(),
      expectedTaskCount: this.options.requireDispatchSeal ? undefined : 1,
      dispatchSealed: this.options.requireDispatchSeal !== true,
      launchAttested: false
    })
    const pending = this.pendingLaunches.get(JSON.stringify([parent.runId, origin.toolCallId]))
    if (pending) {
      this.pendingLaunches.delete(JSON.stringify([parent.runId, origin.toolCallId]))
      this.acceptTaskLaunch(pending)
    }
  }

  captureParent(started: RpcChildStarted): { readonly runId: string } | undefined {
    const task = this.native.get(started.id) ?? this.tasks.get(started.parentToolCallId)
    if (
      this.disposed ||
      !task ||
      task.toolCallId !== started.parentToolCallId ||
      (started.detached && !this.options.allowBackground) ||
      (this.native.has(started.id) && this.native.get(started.id) !== task)
    )
      return undefined
    if (
      !task.nativeIds.has(started.id) &&
      task.nativeIds.size >= (task.expectedTaskCount ?? this.maximum)
    ) {
      if (!task.launchAttested && this.maximum === 1) return undefined
      task.conflict = true
    }
    task.nativeIds.add(started.id)
    this.native.set(started.id, task)
    this.notify()
    return Object.freeze({ runId: task.parent.runId })
  }

  observeTaskEnd(frame: RpcFrame): void {
    if (
      this.disposed ||
      frame.type !== 'tool_execution_end' ||
      frame.toolName !== 'task' ||
      typeof frame.toolCallId !== 'string' ||
      typeof frame.isError !== 'boolean'
    )
      return
    const task = this.tasks.get(frame.toolCallId)
    if (task && !task.nativeIds.size) {
      // A finished task without its observed start is uncertain, never evidence of an empty child set.
      task.endedWithoutStart = true
      this.notify()
    }
  }
  /** Only the runtime's verified, generation-bound HMAC receipt may enter here. */
  acceptTaskLaunch(proof: VerifiedTaskLaunchExpectation): void {
    if (
      this.disposed ||
      !Number.isSafeInteger(proof.declaredTaskCount) ||
      proof.declaredTaskCount < 1 ||
      proof.declaredTaskCount > this.maximum ||
      !Number.isSafeInteger(proof.expectedTaskCount) ||
      proof.expectedTaskCount < 0 ||
      proof.expectedTaskCount > proof.declaredTaskCount ||
      (!proof.dispatchSealed && proof.expectedTaskCount !== proof.declaredTaskCount)
    )
      throw new Error('Invalid authenticated task dispatch count')
    const task = this.tasks.get(proof.toolCallId)
    if (!task || task.parent.runId !== proof.parentRunId) {
      const parent = this.options.currentParentRun()
      if (
        !parent ||
        parent.runId !== proof.parentRunId ||
        parent.sessionId !== this.options.phiSessionId ||
        parent.signal.aborted ||
        this.pendingLaunches.size >= MAX_EXECUTION_CALLS
      )
        throw new Error('Task launch receipt lacks its registered parent')
      const key = JSON.stringify([proof.parentRunId, proof.toolCallId])
      const previous = this.pendingLaunches.get(key)
      if (previous?.dispatchSealed && !proof.dispatchSealed) return
      if (
        previous &&
        (previous.inputDigest !== proof.inputDigest ||
          previous.controlSequence !== proof.controlSequence ||
          previous.declaredTaskCount !== proof.declaredTaskCount)
      )
        throw new Error('Task launch receipt was replaced')
      this.pendingLaunches.set(key, Object.freeze({ ...proof }))
      return
    }
    if (
      task.digest !== proof.inputDigest ||
      task.controlSequence !== proof.controlSequence ||
      (task.declaredTaskCount !== undefined && task.declaredTaskCount !== proof.declaredTaskCount)
    )
      throw new Error('Task launch receipt differs from its authenticated origin')
    if (task.launchAttested && task.dispatchSealed) {
      if (!proof.dispatchSealed) return
      if (task.expectedTaskCount !== proof.expectedTaskCount)
        throw new Error('Task dispatch seal was replaced')
      return
    }
    task.declaredTaskCount = proof.declaredTaskCount
    task.expectedTaskCount = proof.expectedTaskCount
    task.dispatchSealed = proof.dispatchSealed
    task.launchAttested = true
    if (task.nativeIds.size > proof.expectedTaskCount) task.conflict = true
    this.notify()
  }

  /** Caller must first verify the private receipt HMAC and immutable generation/root configuration. */
  consumeNoSpawn(proof: Readonly<RpcTaskSettlement>): SessionRun | undefined {
    const task = this.tasks.get(proof.toolCallId)
    if (
      this.disposed ||
      !task ||
      task.parent.runId !== proof.parentRunId ||
      task.controlSequence !== proof.controlSequence ||
      task.digest !== proof.inputDigest
    )
      return undefined
    task.noSpawn = true
    this.retirement.add(task.parent.runId)
    this.notify()
    return task.parent
  }

  needsGenerationRetirement(parentRunId: string): boolean {
    return this.retirement.has(parentRunId)
  }

  hasNoSpawnConflict(parentRunId: string): boolean {
    return [...this.native.values()].some(
      (task) =>
        task.parent.runId === parentRunId && (task.noSpawn === true || task.conflict === true)
    )
  }

  assertNoPendingStarts(parentRunId: string): void {
    if (this.disposed) throw new Error('Child parent ledger is unavailable')
    const pending = [...this.tasks.values()].filter(
      (task) =>
        task.parent.runId === parentRunId &&
        !task.noSpawn &&
        (!task.dispatchSealed ||
          task.expectedTaskCount === undefined ||
          task.expectedTaskCount === 0 ||
          task.nativeIds.size < task.expectedTaskCount)
    )
    if (pending.some((task) => task.endedWithoutStart))
      throw new Error(
        'Task ended without an observed native start; child settlement is unconfirmed'
      )
    if (pending.length)
      throw new Error('Authenticated task origins still have pending native starts')
    if (this.hasNoSpawnConflict(parentRunId))
      throw new Error('No-spawn proof conflicts with an observed native child')
  }

  async waitForStarts(parentRunId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted()
      if (this.disposed) throw new Error('Child parent ledger is unavailable')
      const pending = [...this.tasks.values()].filter(
        (task) =>
          task.parent.runId === parentRunId &&
          !task.noSpawn &&
          (!task.dispatchSealed ||
            task.expectedTaskCount === undefined ||
            task.expectedTaskCount === 0 ||
            task.nativeIds.size < task.expectedTaskCount)
      )
      if (!pending.length) return
      let wake!: () => void
      const changed = new Promise<void>((resolve) => {
        wake = resolve
        this.changed.add(wake)
      })
      try {
        await withRemoteSignal(changed, signal)
      } finally {
        this.changed.delete(wake)
      }
    }
  }

  private notify(): void {
    for (const wake of this.changed) wake()
  }

  parentForNative(nativeId: string): SessionRun | undefined {
    return this.disposed ? undefined : this.native.get(nativeId)?.parent
  }

  parent(runId: string): SessionRun | undefined {
    return this.disposed ? undefined : this.parents.get(runId)?.run
  }
  nativeIdsForParent(parentRunId: string): readonly string[] {
    return Object.freeze(
      [...this.native.entries()]
        .filter(([, task]) => task.parent.runId === parentRunId)
        .map(([id]) => id)
    )
  }
  hasPendingStarts(): boolean {
    return [...this.tasks.values()].some(
      (task) =>
        !task.noSpawn &&
        (!task.dispatchSealed ||
          task.expectedTaskCount === undefined ||
          task.expectedTaskCount === 0 ||
          task.nativeIds.size < task.expectedTaskCount)
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.notify()
    for (const parent of this.parents.values()) parent.detach()
    this.parents.clear()
    this.tasks.clear()
    this.native.clear()
    this.pendingLaunches.clear()
  }
}
