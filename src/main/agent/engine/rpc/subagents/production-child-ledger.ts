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
  nativeId?: string
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
}

/** Only the execution authority's verified origin callback admits a parent task. */
export class ProductionChildLedger {
  private readonly tasks = new Map<string, ParentTask>()
  private readonly parents = new Map<string, { run: SessionRun; detach: () => void }>()
  private readonly native = new Map<string, ParentTask>()
  private readonly changed = new Set<() => void>()
  private readonly retirement = new Set<string>()
  private disposed = false

  constructor(private readonly options: ProductionChildLedgerOptions) {
    this.options = Object.freeze({ ...options })
  }

  remember({ origin, run }: RpcVerifiedTaskOrigin): void {
    const parent = this.options.currentParentRun()
    const previous = this.tasks.get(origin.toolCallId)
    const reusable =
      !!parent &&
      !!previous?.nativeId &&
      !previous.noSpawn &&
      previous.parent.runId !== parent.runId &&
      this.options.isNativeTerminal?.(previous.nativeId, previous.parent.runId) === true
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
      controlSequence: origin.sequence
    })
  }

  captureParent(started: RpcChildStarted): { readonly runId: string } | undefined {
    const task = this.native.get(started.id) ?? this.tasks.get(started.parentToolCallId)
    if (
      this.disposed ||
      !task ||
      task.toolCallId !== started.parentToolCallId ||
      started.detached ||
      (task.nativeId !== undefined && task.nativeId !== started.id) ||
      (this.native.has(started.id) && this.native.get(started.id) !== task)
    )
      return undefined
    task.nativeId = started.id
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
    if (task && !task.nativeId) {
      // A finished task without its observed start is uncertain, never evidence of an empty child set.
      task.endedWithoutStart = true
      this.notify()
    }
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
      (task) => task.parent.runId === parentRunId && task.noSpawn === true
    )
  }

  assertNoPendingStarts(parentRunId: string): void {
    if (this.disposed) throw new Error('Child parent ledger is unavailable')
    const pending = [...this.tasks.values()].filter(
      (task) => task.parent.runId === parentRunId && !task.nativeId && !task.noSpawn
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
        (task) => task.parent.runId === parentRunId && !task.nativeId && !task.noSpawn
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

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.notify()
    for (const parent of this.parents.values()) parent.detach()
    this.parents.clear()
    this.tasks.clear()
    this.native.clear()
  }
}
