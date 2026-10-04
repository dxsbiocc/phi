export interface PreventableQuitEvent {
  preventDefault(): void
}

export interface BeforeQuitHandlerOptions {
  /** Synchronous shutdown steps that must run once, before async cleanup starts. */
  beginShutdown: () => void
  /** Async cleanup; quit resumes when it settles or after `timeoutMs`. */
  cleanup: () => Promise<void>
  /** Resumes the quit, normally `app.quit()`. */
  quit: () => void
  timeoutMs: number
  /** Schedules the resumed quit on a later macrotask. Injected for tests. */
  defer?: (resume: () => void) => void
}

export function waitForCleanupOrTimeout(cleanup: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    void cleanup.then(finish, finish)
  })
}

/**
 * Builds the `before-quit` listener that holds the quit until cleanup finishes.
 *
 * The resumed `quit()` must run on a fresh macrotask. Electron drains microtasks
 * before its own Browser::Quit returns from emitting `before-quit`; when cleanup
 * settles within that drain (nothing slow to stop), a nested `app.quit()` starts
 * quitting and the outer, prevented call then clears Electron's quitting flag.
 * The windows still close, but `will-quit` never fires and the macOS app stays
 * alive after SIGTERM or Cmd+Q.
 */
export function createBeforeQuitHandler(
  options: BeforeQuitHandlerOptions
): (event: PreventableQuitEvent) => void {
  const defer = options.defer ?? ((resume: () => void) => void setImmediate(resume))
  let cleanupComplete = false
  let resumeScheduled = false

  return (event) => {
    if (cleanupComplete) return
    event.preventDefault()
    if (resumeScheduled) return
    resumeScheduled = true
    options.beginShutdown()
    let cleanup: Promise<void>
    try {
      cleanup = options.cleanup()
    } catch (error) {
      cleanup = Promise.reject(error)
    }
    void waitForCleanupOrTimeout(cleanup, options.timeoutMs).then(() => {
      cleanupComplete = true
      defer(() => options.quit())
    })
  }
}
