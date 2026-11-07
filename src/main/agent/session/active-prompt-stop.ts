interface ManualCompactionOperation {
  session?: { abort(): Promise<void> }
  cancelled: boolean
  done: Promise<void>
}

export interface ActivePromptStopOptions {
  getCurrentSessionKey: () => string
  advancePromptGeneration: (sessionKey: string) => number
  getActivePromptRun: (sessionKey: string) => unknown
  getPhiSessionIdForKey: (sessionKey: string) => string | undefined
  getManualCompactionOperation: (sessionId: string) => ManualCompactionOperation | undefined
  stopPromptRun: (sessionKey: string, run: unknown, invalidateGeneration: boolean) => Promise<void>
}

export async function stopActivePrompt(options: ActivePromptStopOptions): Promise<void> {
  // Invalidate queued work even before its queue callback sets activePromptRun.
  options.advancePromptGeneration(options.getCurrentSessionKey())
  const run = options.getActivePromptRun(options.getCurrentSessionKey())
  if (!run) {
    const phiSessionId = options.getPhiSessionIdForKey(options.getCurrentSessionKey())
    const operation = phiSessionId ? options.getManualCompactionOperation(phiSessionId) : undefined
    if (operation) {
      operation.cancelled = true
      try {
        if (operation.session) await operation.session.abort()
      } finally {
        await operation.done
      }
    }
    return
  }

  await options.stopPromptRun(options.getCurrentSessionKey(), run, false)
}
