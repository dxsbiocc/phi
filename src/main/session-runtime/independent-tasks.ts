import { INDEPENDENT_TASK_AGENT } from '../../shared/independentTask'
import { isRecord } from '../../shared/guards'
import { redactSensitiveText } from '../agent/redaction'
import type { AssistantInboxEntry, ClaimedEntry } from './assistant-inbox'
import type { SettleDetail } from './assistant-inbox-dispatch'

export const DEFAULT_INDEPENDENT_TASKS_PER_CONVERSATION = 2
const WAIT_SLICE_MS = 2_000

export interface IndependentTaskEngine {
  start(params: {
    sessionId: string
    agent?: string
    task: string
    requestId: string
  }): Promise<{ runId: string }>
  list(sessionId: string): Promise<unknown>
  stop(params: { sessionId: string; runId: string }): Promise<unknown>
  wait(params: {
    sessionId: string
    ids: readonly string[]
    mode?: 'all' | 'any'
    timeoutMs?: number
  }): Promise<unknown>
}

/** Inbox primitives the durable chat owns; scope is bound by the caller's closure. */
export interface IndependentTaskStoreOps {
  read(id: string): Promise<AssistantInboxEntry | undefined>
  bindChild(id: string, attemptId: string, childRunId: string): Promise<boolean>
  requestCancel(id: string, attemptId: string): Promise<boolean>
}

export interface IndependentTaskChannel {
  prepare(
    entry: AssistantInboxEntry,
    runningInConversation: number
  ): Promise<'ready' | 'wait' | 'invalid'>
  execute(
    entry: ClaimedEntry,
    ops: IndependentTaskStoreOps,
    signal: AbortSignal
  ): Promise<SettleDetail | undefined>
  /** Undefined keeps the entry running until its own child receipt proves a terminal state. */
  reconcile(
    entry: AssistantInboxEntry,
    ops: IndependentTaskStoreOps,
    afterRestart: boolean
  ): Promise<SettleDetail | undefined>
  cancel(entry: AssistantInboxEntry, ops: IndependentTaskStoreOps): Promise<boolean>
}

export interface IndependentTaskRunsOptions {
  engine: IndependentTaskEngine
  /** Opens the saved local session and verifies its durable binding. */
  runtimeSession(entry: AssistantInboxEntry): Promise<string | undefined>
  isBound(entry: AssistantInboxEntry): boolean
  maxPerConversation?: number
  waitSliceMs?: number
  log(error: unknown): void
}

function terminalOutcome(value: Record<string, unknown>): SettleDetail | undefined {
  const state = value.state
  if (state !== 'done' && state !== 'error' && state !== 'cancelled' && state !== 'unknown') {
    return undefined
  }
  const report = typeof value.report === 'string' ? value.report : value.error
  const result = typeof report === 'string' ? redactSensitiveText(report) : undefined
  const status =
    state === 'done' && value.reportStatus === 'completed'
      ? 'succeeded'
      : state === 'cancelled'
        ? 'cancelled'
        : state === 'unknown'
          ? 'interrupted'
          : 'failed'
  return { status, ...(result ? { result } : {}) }
}

class IndependentTaskRuns implements IndependentTaskChannel {
  constructor(private readonly options: IndependentTaskRunsOptions) {}

  private async stopChild(runtimeSessionId: string, runId: string): Promise<void> {
    try {
      await this.options.engine.stop({ sessionId: runtimeSessionId, runId })
    } catch (error) {
      this.options.log(error)
    }
  }

  /** Waits on the exact child run and verifies both identities before trusting the snapshot. */
  private async waitOnce(
    runtimeSessionId: string,
    runId: string,
    requestId: string,
    timeoutMs: number
  ): Promise<SettleDetail | undefined> {
    const result = await this.options.engine.wait({
      sessionId: runtimeSessionId,
      ids: [runId],
      mode: 'all',
      timeoutMs
    })
    if (!Array.isArray(result)) throw new Error('Kernel child wait returned an unexpected result.')
    for (const item of result) {
      if (!isRecord(item) || !isRecord(item.run)) continue
      if (item.run.runId !== runId) continue
      if (item.run.requestId !== requestId) {
        throw new Error('Kernel child receipt does not match the task attempt.')
      }
      const outcome = terminalOutcome(item.run)
      if (outcome) return outcome
    }
    return undefined
  }

  private async findReceipt(
    runtime: string,
    entry: ClaimedEntry
  ): Promise<Record<string, unknown> | undefined> {
    const receipts = await this.options.engine.list(runtime)
    if (!Array.isArray(receipts)) throw new Error('Kernel child receipts are unavailable.')
    const receipt = receipts.find((value) => isRecord(value) && value.requestId === entry.attemptId)
    if (!isRecord(receipt)) return undefined
    if (
      receipt.origin !== 'host' ||
      receipt.agent !== INDEPENDENT_TASK_AGENT ||
      (entry.childRunId && entry.childRunId !== receipt.runId)
    ) {
      throw new Error('Kernel child receipt does not match the bound task.')
    }
    return receipt
  }

  private async bind(
    entry: ClaimedEntry,
    ops: IndependentTaskStoreOps,
    runId: string
  ): Promise<boolean> {
    return ops.bindChild(entry.id, entry.attemptId, runId).catch((error: unknown) => {
      this.options.log(error)
      return ops.bindChild(entry.id, entry.attemptId, runId)
    })
  }

  private async watchChild(
    entry: ClaimedEntry,
    ops: IndependentTaskStoreOps,
    runtime: string,
    runId: string,
    signal: AbortSignal
  ): Promise<SettleDetail | undefined> {
    for (;;) {
      if (signal.aborted) return undefined
      const fresh = await ops.read(entry.id)
      if (!fresh || fresh.status !== 'running' || fresh.attemptId !== entry.attemptId)
        return undefined
      if (fresh.cancelRequested) await this.stopChild(runtime, runId)
      try {
        const outcome = await this.waitOnce(
          runtime,
          runId,
          entry.attemptId,
          this.options.waitSliceMs ?? WAIT_SLICE_MS
        )
        if (outcome) return outcome
      } catch (error) {
        this.options.log(error)
        // A lost response is reconciled by the request ID. Never submit again.
        return undefined
      }
    }
  }

  async execute(
    entry: ClaimedEntry,
    ops: IndependentTaskStoreOps,
    signal: AbortSignal
  ): Promise<SettleDetail | undefined> {
    if (signal.aborted) return { status: 'defer' }
    const runtime = await this.options.runtimeSession(entry)
    const current = await ops.read(entry.id)
    if (!current || current.status !== 'running' || current.attemptId !== entry.attemptId)
      return undefined
    if (current.cancelRequested) return { status: 'cancelled' }
    if (!runtime || signal.aborted) return { status: 'defer' }
    let runId: string
    try {
      const started = await this.options.engine.start({
        sessionId: runtime,
        agent: INDEPENDENT_TASK_AGENT,
        task: entry.text,
        requestId: entry.attemptId
      })
      runId = started.runId
    } catch (error) {
      this.options.log(error)
      return undefined
    }
    if (!(await this.bind(entry, ops, runId))) {
      await this.stopChild(runtime, runId)
      return undefined
    }
    return this.watchChild(entry, ops, runtime, runId, signal)
  }

  async reconcile(
    entry: AssistantInboxEntry,
    ops: IndependentTaskStoreOps,
    afterRestart: boolean
  ): Promise<SettleDetail | undefined> {
    if (entry.status !== 'running' || !entry.attemptId) return undefined
    if (!this.options.isBound(entry)) return { status: 'interrupted' }
    const runtime = await this.options.runtimeSession(entry)
    if (!runtime) return undefined
    const claimed = { ...entry, status: 'running' as const, attemptId: entry.attemptId }
    const receipt = await this.findReceipt(runtime, claimed)
    if (!receipt) return afterRestart ? { status: 'interrupted' } : undefined
    const runId = typeof receipt.runId === 'string' ? receipt.runId : undefined
    if (!runId) return receipt.state === 'unknown' ? terminalOutcome(receipt) : undefined
    if (!(await this.bind(claimed, ops, runId))) return undefined
    const fresh = await ops.read(entry.id)
    if (fresh?.cancelRequested) await this.stopChild(runtime, runId)
    return this.waitOnce(runtime, runId, entry.attemptId, 0)
  }

  async prepare(
    entry: AssistantInboxEntry,
    runningInConversation: number
  ): Promise<'ready' | 'wait' | 'invalid'> {
    if (!this.options.isBound(entry)) return 'invalid'
    if (
      runningInConversation >=
      (this.options.maxPerConversation ?? DEFAULT_INDEPENDENT_TASKS_PER_CONVERSATION)
    )
      return 'wait'
    return (await this.options.runtimeSession(entry)) ? 'ready' : 'wait'
  }

  async cancel(entry: AssistantInboxEntry, ops: IndependentTaskStoreOps): Promise<boolean> {
    if (
      entry.status !== 'running' ||
      !entry.attemptId ||
      !(await ops.requestCancel(entry.id, entry.attemptId))
    )
      return false
    try {
      const runtime = await this.options.runtimeSession(entry)
      if (runtime) {
        const receipt = await this.findReceipt(runtime, {
          ...entry,
          status: 'running',
          attemptId: entry.attemptId
        })
        if (typeof receipt?.runId === 'string') await this.stopChild(runtime, receipt.runId)
      }
    } catch (error) {
      this.options.log(error)
    }
    return true
  }
}

export function createIndependentTaskRuns(
  options: IndependentTaskRunsOptions
): IndependentTaskChannel {
  return new IndependentTaskRuns(options)
}
