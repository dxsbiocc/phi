import {
  appendSessionEvent,
  updateSessionManifest,
  type LastRunOutcome,
  type SessionStatus,
  type SessionEventInput,
  type StoredSessionEvent
} from './session-store'
import { writeAppLog } from '../app-logger'
import { redactSensitiveText } from '../redaction'

export interface SessionRunContext {
  signal: AbortSignal
}

export interface StartSessionRunInput {
  sessionId: string
  runId: string
  execute: (context: SessionRunContext) => Promise<void>
  getRecordedFailure?: () => string | null | undefined
}

export interface SessionRun {
  readonly sessionId: string
  readonly runId: string
  readonly signal: AbortSignal
  readonly startedAt: string
  readonly done: Promise<void>
  status: Extract<SessionStatus, 'running' | 'needs_approval' | 'needs_input'>
  outcome?: LastRunOutcome
}

interface MutableSessionRun extends SessionRun {
  controller: AbortController
  done: Promise<void>
}

export interface SessionRunnerRegistryOptions {
  maxActiveRuns?: number
  onSessionEvent?: (sessionId: string, event: StoredSessionEvent) => void
}

const DEFAULT_MAX_ACTIVE_RUNS = 4

function errorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
}

function createStopReason(): Error {
  return new Error('运行已停止')
}

function runDurationMs(run: SessionRun, endedAt: string): number {
  const started = Date.parse(run.startedAt)
  const ended = Date.parse(endedAt)
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return 0
  return Math.max(0, ended - started)
}

export class SessionRunnerRegistry {
  private readonly maxActiveRuns: number
  private readonly activeRuns = new Map<string, MutableSessionRun>()
  private readonly onSessionEvent?: (sessionId: string, event: StoredSessionEvent) => void

  constructor(options: SessionRunnerRegistryOptions = {}) {
    this.maxActiveRuns = options.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS
    this.onSessionEvent = options.onSessionEvent
  }

  private appendEvent(sessionId: string, event: SessionEventInput): StoredSessionEvent {
    const stored = appendSessionEvent(sessionId, event)
    this.onSessionEvent?.(sessionId, stored)
    return stored
  }

  get activeCount(): number {
    return this.activeRuns.size
  }

  getActiveRun(sessionId: string): SessionRun | null {
    return this.activeRuns.get(sessionId) ?? null
  }

  getActiveRuns(): SessionRun[] {
    return [...this.activeRuns.values()]
  }

  startRun(input: StartSessionRunInput): SessionRun {
    if (this.activeRuns.has(input.sessionId)) {
      throw new Error('会话正在运行')
    }
    if (this.activeRuns.size >= this.maxActiveRuns) {
      throw new Error('运行中的会话已达上限')
    }

    const controller = new AbortController()
    const startedAt = new Date().toISOString()
    this.appendEvent(input.sessionId, {
      type: 'run_started',
      runId: input.runId,
      createdAt: startedAt
    })
    writeAppLog({
      event: 'run_started',
      sessionId: input.sessionId,
      runId: input.runId
    })
    updateSessionManifest(input.sessionId, {
      status: 'running',
      currentRunId: input.runId,
      currentRunStartedAt: startedAt,
      unreadKind: null
    })

    const run: MutableSessionRun = {
      sessionId: input.sessionId,
      runId: input.runId,
      signal: controller.signal,
      controller,
      startedAt,
      status: 'running',
      done: Promise.resolve()
    }

    run.done = Promise.resolve()
      .then(() => input.execute({ signal: controller.signal }))
      .then(() => {
        const recordedFailure = input.getRecordedFailure?.()
        if (recordedFailure) {
          const failedAt = new Date().toISOString()
          run.outcome = 'failed'
          this.appendEvent(input.sessionId, {
            type: 'run_failed',
            runId: input.runId,
            createdAt: failedAt,
            durationMs: runDurationMs(run, failedAt),
            errorMessage: errorMessage(recordedFailure)
          })
          updateSessionManifest(input.sessionId, {
            status: 'failed',
            currentRunId: undefined,
            currentRunStartedAt: undefined,
            unreadKind: 'failed',
            lastRunOutcome: run.outcome
          })
          writeAppLog({
            level: 'error',
            event: 'run_failed',
            sessionId: input.sessionId,
            runId: input.runId,
            metadata: { error: errorMessage(recordedFailure) }
          })
          return
        }

        const completedAt = new Date().toISOString()
        run.outcome = controller.signal.aborted ? 'stopped' : 'completed'
        this.appendEvent(input.sessionId, {
          type: run.outcome === 'stopped' ? 'run_interrupted' : 'run_completed',
          runId: input.runId,
          createdAt: completedAt,
          durationMs: runDurationMs(run, completedAt)
        })
        writeAppLog({
          event: run.outcome === 'stopped' ? 'run_interrupted' : 'run_completed',
          sessionId: input.sessionId,
          runId: input.runId
        })
        updateSessionManifest(input.sessionId, {
          status: run.outcome === 'completed' ? 'completed_unread' : 'idle',
          currentRunId: undefined,
          currentRunStartedAt: undefined,
          unreadKind: run.outcome === 'completed' ? 'completed' : null,
          lastRunOutcome: run.outcome
        })
      })
      .catch((error) => {
        const completedAt = new Date().toISOString()
        run.outcome = controller.signal.aborted ? 'stopped' : 'failed'
        this.appendEvent(input.sessionId, {
          type: run.outcome === 'stopped' ? 'run_interrupted' : 'run_failed',
          runId: input.runId,
          createdAt: completedAt,
          durationMs: runDurationMs(run, completedAt),
          errorMessage: errorMessage(error)
        })
        writeAppLog({
          level: run.outcome === 'failed' ? 'error' : 'info',
          event: run.outcome === 'stopped' ? 'run_interrupted' : 'run_failed',
          sessionId: input.sessionId,
          runId: input.runId,
          metadata: run.outcome === 'failed' ? { error: errorMessage(error) } : undefined
        })
        updateSessionManifest(input.sessionId, {
          status: run.outcome === 'failed' ? 'failed' : 'idle',
          currentRunId: undefined,
          currentRunStartedAt: undefined,
          unreadKind: run.outcome === 'failed' ? 'failed' : null,
          lastRunOutcome: run.outcome
        })
      })
      .finally(() => {
        if (this.activeRuns.get(input.sessionId) === run) {
          this.activeRuns.delete(input.sessionId)
        }
      })

    this.activeRuns.set(input.sessionId, run)
    return run
  }

  markNeedsApproval(
    sessionId: string,
    approvalId: string,
    metadata: { toolName?: string; summary?: string } = {}
  ): void {
    const run = this.activeRuns.get(sessionId)
    if (!run) return

    run.status = 'needs_approval'
    this.appendEvent(sessionId, {
      type: 'approval_requested',
      runId: run.runId,
      approvalId,
      ...metadata
    })
    writeAppLog({
      event: 'approval_requested',
      sessionId,
      runId: run.runId,
      metadata: {
        approvalId,
        toolName: metadata.toolName,
        summary: metadata.summary
      }
    })
    updateSessionManifest(sessionId, {
      status: 'needs_approval',
      unreadKind: 'approval'
    })
  }

  markApprovalApproved(sessionId: string, approvalId: string): void {
    const run = this.activeRuns.get(sessionId)
    if (!run) return

    run.status = 'running'
    this.appendEvent(sessionId, {
      type: 'approval_approved',
      runId: run.runId,
      approvalId
    })
    writeAppLog({
      event: 'approval_approved',
      sessionId,
      runId: run.runId,
      metadata: { approvalId }
    })
    updateSessionManifest(sessionId, {
      status: 'running',
      unreadKind: null
    })
  }

  markApprovalDenied(sessionId: string, approvalId: string): void {
    const run = this.activeRuns.get(sessionId)
    if (!run) return

    this.appendEvent(sessionId, {
      type: 'approval_denied',
      runId: run.runId,
      approvalId
    })
    writeAppLog({
      level: 'warn',
      event: 'approval_denied',
      sessionId,
      runId: run.runId,
      metadata: { approvalId }
    })
    updateSessionManifest(sessionId, {
      status: 'failed',
      unreadKind: 'failed',
      lastRunOutcome: 'failed'
    })
  }

  markApprovalCancelled(sessionId: string, approvalId: string): void {
    const run = this.activeRuns.get(sessionId)
    if (!run) return

    this.appendEvent(sessionId, {
      type: 'approval_cancelled',
      runId: run.runId,
      approvalId
    })
    writeAppLog({
      event: 'approval_cancelled',
      sessionId,
      runId: run.runId,
      metadata: { approvalId }
    })
  }

  markNeedsInput(
    sessionId: string,
    interactionId: string,
    metadata: { kind?: string; message?: string } = {}
  ): void {
    const run = this.activeRuns.get(sessionId)
    if (!run) return

    run.status = 'needs_input'
    this.appendEvent(sessionId, {
      type: 'input_requested',
      runId: run.runId,
      interactionId,
      ...metadata
    })
    writeAppLog({
      event: 'input_requested',
      sessionId,
      runId: run.runId,
      metadata: {
        interactionId,
        kind: metadata.kind,
        message: metadata.message
      }
    })
    updateSessionManifest(sessionId, {
      status: 'needs_input',
      unreadKind: 'input'
    })
  }

  markInputAnswered(sessionId: string, interactionId: string): void {
    const run = this.activeRuns.get(sessionId)
    if (!run) return

    run.status = 'running'
    this.appendEvent(sessionId, {
      type: 'input_answered',
      runId: run.runId,
      interactionId
    })
    writeAppLog({
      event: 'input_answered',
      sessionId,
      runId: run.runId,
      metadata: { interactionId }
    })
    updateSessionManifest(sessionId, {
      status: 'running',
      unreadKind: null
    })
  }

  markInputCancelled(sessionId: string, interactionId: string): void {
    const run = this.activeRuns.get(sessionId)
    if (!run) return

    run.status = 'running'
    this.appendEvent(sessionId, {
      type: 'input_cancelled',
      runId: run.runId,
      interactionId
    })
    writeAppLog({
      event: 'input_cancelled',
      sessionId,
      runId: run.runId,
      metadata: { interactionId }
    })
    updateSessionManifest(sessionId, {
      status: 'running',
      unreadKind: null
    })
  }

  markRunning(sessionId: string): void {
    const run = this.activeRuns.get(sessionId)
    if (!run) return

    run.status = 'running'
    this.appendEvent(sessionId, { type: 'run_resumed', runId: run.runId })
    updateSessionManifest(sessionId, {
      status: 'running',
      unreadKind: null
    })
  }

  stopRun(sessionId: string): void {
    const run = this.activeRuns.get(sessionId)
    if (!run || run.signal.aborted) return
    run.controller.abort(createStopReason())
  }

  stopAll(): void {
    for (const run of this.activeRuns.values()) {
      if (!run.signal.aborted) {
        run.controller.abort(createStopReason())
      }
    }
  }
}
