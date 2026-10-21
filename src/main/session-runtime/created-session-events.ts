import type { PhiAgentEvent } from '../agent/engine/types'
import type { SessionSnapshot } from '../agent/session/session-lifecycle'
import {
  persistSessionEvent as persistSessionEventWithDeps,
  type SessionEventPersistenceDeps,
  type SessionEventPersistenceRun
} from '../agent/session/session-event-persistence'

type CreatedSessionRun = SessionEventPersistenceRun

interface CreatedSessionLifecycle {
  isCurrentGeneration(generation: number): boolean
}

export interface CreatedSessionContext {
  sessionKey: string
  generation: number
  snapshot: SessionSnapshot
  lifecycle: CreatedSessionLifecycle
}

export interface CreatedSessionInstance<TEvent extends PhiAgentEvent = PhiAgentEvent> {
  sessionFile?: string
  subscribe(listener: (event: TEvent) => void): () => void
}

export interface CreatedSessionResult<
  TSession extends CreatedSessionInstance<TEvent>,
  TEvent extends PhiAgentEvent = PhiAgentEvent
> {
  session: TSession
}

export interface CreatedSessionEventsDeps<
  TRun extends CreatedSessionRun,
  TSession extends CreatedSessionInstance<TEvent>,
  TEvent extends PhiAgentEvent = PhiAgentEvent
> {
  state: {
    promptRuns: { activeRun(sessionKey: string): TRun | undefined }
    sessionKeys: { phiSessionIdFor(sessionKey: string): string | undefined }
  }
  persistence: {
    storage: SessionEventPersistenceDeps['storage']
    extractAssistantText(message: unknown): string
    redactStructuredValue(value: unknown): unknown
  }
  runtime: {
    redactSensitiveText(message: string): string
    abortSessionWithoutCancellingApprovals(session: TSession): Promise<void>
    phiOnlySessionPath(sessionId: string): string
  }
  events: {
    publish(payload: Record<string, unknown>): void
    logUnexpectedError(error: unknown): void
  }
}

export interface CreatedSessionEvents<
  TRun extends CreatedSessionRun,
  TSession extends CreatedSessionInstance<TEvent>,
  TEvent extends PhiAgentEvent = PhiAgentEvent
> {
  stopCreatedSessionForPermanentProviderError(
    run: TRun | undefined,
    summary: PhiAgentEvent,
    session: TSession
  ): void
  handleCreatedSessionEvent(
    context: CreatedSessionContext,
    result: CreatedSessionResult<TSession, TEvent>,
    rawSummary: TEvent
  ): void
  subscribeToCreatedSession(
    context: CreatedSessionContext,
    result: CreatedSessionResult<TSession, TEvent>
  ): void
}

class CreatedSessionEventsService<
  TRun extends CreatedSessionRun,
  TSession extends CreatedSessionInstance<TEvent>,
  TEvent extends PhiAgentEvent = PhiAgentEvent
> {
  private readonly sessionEventPersistenceDeps: SessionEventPersistenceDeps

  constructor(private readonly deps: CreatedSessionEventsDeps<TRun, TSession, TEvent>) {
    this.sessionEventPersistenceDeps = {
      storage: deps.persistence.storage,
      shared: {
        createdAtFromSummary: this.createdAtFromSummary,
        extractAssistantText: deps.persistence.extractAssistantText,
        persistSdkCompactionNotice: this.persistSdkCompactionNotice,
        persistSdkShakeEvent: this.persistSdkShakeEvent,
        redactStructuredValue: deps.persistence.redactStructuredValue
      }
    }
  }
  private readonly createdAtFromSummary = (
    summary: Record<string, unknown>
  ): { createdAt: string } | Record<string, never> => {
    if (typeof summary.createdAt !== 'string') return {}
    return Number.isFinite(Date.parse(summary.createdAt)) ? { createdAt: summary.createdAt } : {}
  }

  private readonly withEventTimestamp = (summary: TEvent): PhiAgentEvent =>
    Object.keys(this.createdAtFromSummary(summary)).length > 0
      ? summary
      : { ...summary, createdAt: new Date().toISOString() }

  private readonly persistSdkCompactionNotice = (
    phiSessionId: string,
    runId: string | undefined,
    summary: Record<string, unknown>
  ): Record<string, unknown> | null => {
    if (
      summary.type !== 'notice' ||
      summary.source !== 'compaction' ||
      typeof summary.message !== 'string'
    ) {
      return null
    }
    const stored = this.deps.persistence.storage.appendSessionEvent(phiSessionId, {
      type: 'context_maintenance_notice',
      ...(runId ? { runId } : {}),
      ...this.createdAtFromSummary(summary),
      noticeLevel: summary.level === 'error' ? 'error' : 'info',
      noticeText: summary.message.slice(0, 1000)
    })
    return { source: 'phi', ...stored }
  }

  private readonly persistSdkShakeEvent = (
    phiSessionId: string,
    runId: string | undefined,
    summary: Record<string, unknown>,
    reason?: string
  ): Record<string, unknown> | null => {
    if (summary.type !== 'auto_compaction_end' || summary.action !== 'shake' || summary.skipped) {
      return null
    }
    const stored = this.deps.persistence.storage.appendSessionEvent(phiSessionId, {
      type:
        summary.aborted || summary.errorMessage ? 'context_maintenance_notice' : 'context_shaken',
      ...(runId ? { runId } : {}),
      action: 'shake',
      ...this.createdAtFromSummary(summary),
      ...(reason ? { reason } : {}),
      ...(summary.aborted || summary.errorMessage
        ? {
            noticeLevel: summary.aborted ? 'info' : 'warning',
            noticeText:
              typeof summary.errorMessage === 'string'
                ? summary.errorMessage.slice(0, 1000)
                : '自动精简已取消'
          }
        : {}),
      ...(typeof summary.tokensAfter === 'number' &&
      Number.isFinite(summary.tokensAfter) &&
      summary.tokensAfter >= 0
        ? { tokensAfter: summary.tokensAfter }
        : {})
    })
    return { source: 'phi', ...stored }
  }

  private readonly persistSessionEvent = (
    run: TRun,
    summary: PhiAgentEvent
  ): Record<string, unknown> =>
    persistSessionEventWithDeps(run, summary, this.sessionEventPersistenceDeps)

  private readonly isPermanentProviderRegionError = (message: unknown): message is string =>
    typeof message === 'string' && /(?:not supported|not available) in your region/i.test(message)

  readonly stopCreatedSessionForPermanentProviderError = (
    run: TRun | undefined,
    summary: PhiAgentEvent,
    session: TSession
  ): void => {
    if (
      run &&
      summary.type === 'auto_retry_start' &&
      this.isPermanentProviderRegionError(summary.errorMessage) &&
      !run.stoppingPermanentProviderError
    ) {
      run.stoppingPermanentProviderError = true
      run.recordedFailureMessage = this.deps.runtime.redactSensitiveText(summary.errorMessage)
      void this.deps.runtime.abortSessionWithoutCancellingApprovals(session).catch((error) => {
        this.deps.events.logUnexpectedError(error)
      })
    }
  }

  readonly handleCreatedSessionEvent = (
    context: CreatedSessionContext,
    result: CreatedSessionResult<TSession, TEvent>,
    rawSummary: TEvent
  ): void => {
    if (!context.lifecycle.isCurrentGeneration(context.generation)) return
    const summary = this.withEventTimestamp(rawSummary)
    const run = this.deps.state.promptRuns.activeRun(context.sessionKey)
    this.stopCreatedSessionForPermanentProviderError(run, summary, result.session)
    const phiSessionId =
      run?.phiSessionId ?? this.deps.state.sessionKeys.phiSessionIdFor(context.sessionKey)
    const persistedSummary = run
      ? this.persistSessionEvent(run, summary)
      : phiSessionId
        ? (this.persistSdkCompactionNotice(phiSessionId, undefined, summary) ??
          this.persistSdkShakeEvent(phiSessionId, undefined, summary) ??
          summary)
        : summary
    this.deps.events.publish({
      ...persistedSummary,
      ...(phiSessionId ? { phiSessionId } : {}),
      sessionGeneration: context.generation,
      sessionPath: phiSessionId
        ? this.deps.runtime.phiOnlySessionPath(phiSessionId)
        : (result.session.sessionFile ?? context.snapshot.path ?? null),
      cwd: context.snapshot.cwd
    })
  }

  readonly subscribeToCreatedSession = (
    context: CreatedSessionContext,
    result: CreatedSessionResult<TSession, TEvent>
  ): void => {
    result.session.subscribe((rawSummary) => {
      this.handleCreatedSessionEvent(context, result, rawSummary)
    })
  }
}

export function createCreatedSessionEvents<
  TRun extends CreatedSessionRun,
  TSession extends CreatedSessionInstance<TEvent>,
  TEvent extends PhiAgentEvent = PhiAgentEvent
>(
  deps: CreatedSessionEventsDeps<TRun, TSession, TEvent>
): CreatedSessionEvents<TRun, TSession, TEvent> {
  const service = new CreatedSessionEventsService(deps)
  return {
    stopCreatedSessionForPermanentProviderError:
      service.stopCreatedSessionForPermanentProviderError,
    handleCreatedSessionEvent: service.handleCreatedSessionEvent,
    subscribeToCreatedSession: service.subscribeToCreatedSession
  }
}
