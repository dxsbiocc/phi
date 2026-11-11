export interface StoppablePromptRun<TSession> {
  sessionKey: string
  phiSessionId: string
  runId: string
  cancelled: boolean
  session?: TSession
}

interface StoppableSession {
  abort(options?: { preserveApprovals?: boolean }): Promise<void>
}

export interface PromptRunStopDeps<
  TRun extends StoppablePromptRun<TSession>,
  TSession extends StoppableSession
> {
  runs: {
    advanceGeneration(sessionKey: string): number
    activeRuns(): TRun[]
    activeEntries(): Array<[string, TRun]>
    cancelPendingSubmissions(sessionKey: string): void
    cancelAllPendingSubmissions(): void
  }
  browser: {
    cancel(run: TRun): void
    cleanup(run: TRun): Promise<void>
  }
  agents: {
    stop(phiSessionId: string): void
    stopAll(): void
  }
  waits: {
    cancel(scope?: { sessionId: string; runId: string }): void
  }
  sessions: {
    abort(session: TSession): Promise<void>
  }
}

export interface PromptRunStop<
  TRun extends StoppablePromptRun<TSession>,
  TSession extends StoppableSession
> {
  stopPromptRun(sessionKey: string, run: TRun, invalidateGeneration?: boolean): Promise<void>
  stopAllPromptRuns(): {
    browserCleanup: Promise<void>
    runtimeAbort: Promise<void>
  }
}

async function stopPromptRun<
  TRun extends StoppablePromptRun<TSession>,
  TSession extends StoppableSession
>(
  deps: PromptRunStopDeps<TRun, TSession>,
  sessionKey: string,
  run: TRun,
  invalidateGeneration = true
): Promise<void> {
  if (invalidateGeneration) deps.runs.advanceGeneration(sessionKey)
  // A prompt that is still replaying a deferred invalidation has no active run yet.
  deps.runs.cancelPendingSubmissions(sessionKey)
  run.cancelled = true
  deps.browser.cancel(run)
  const browserCleanup = deps.browser.cleanup(run)
  deps.agents.stop(run.phiSessionId)
  deps.waits.cancel({ sessionId: run.phiSessionId, runId: run.runId })
  if (run.session) {
    await Promise.all([browserCleanup, deps.sessions.abort(run.session)])
  } else {
    await browserCleanup
  }
}

function stopAllPromptRuns<
  TRun extends StoppablePromptRun<TSession>,
  TSession extends StoppableSession
>(
  deps: PromptRunStopDeps<TRun, TSession>
): {
  browserCleanup: Promise<void>
  runtimeAbort: Promise<void>
} {
  const runs = deps.runs.activeRuns()
  deps.runs.cancelAllPendingSubmissions()
  for (const [sessionKey, run] of deps.runs.activeEntries()) {
    deps.runs.advanceGeneration(sessionKey)
    run.cancelled = true
    deps.browser.cancel(run)
  }
  const browserCleanup = Promise.all(runs.map((run) => deps.browser.cleanup(run)))
  deps.agents.stopAll()
  deps.waits.cancel()
  const runtimeAbort = Promise.all(
    runs.map(async (run) => {
      if (!run.session) return
      await deps.sessions.abort(run.session)
    })
  ).then(() => undefined)
  return { browserCleanup: browserCleanup.then(() => undefined), runtimeAbort }
}

export function createPromptRunStop<
  TRun extends StoppablePromptRun<TSession>,
  TSession extends StoppableSession
>(deps: PromptRunStopDeps<TRun, TSession>): PromptRunStop<TRun, TSession> {
  return {
    stopPromptRun: (sessionKey, run, invalidateGeneration) =>
      stopPromptRun(deps, sessionKey, run, invalidateGeneration),
    stopAllPromptRuns: () => stopAllPromptRuns(deps)
  }
}
