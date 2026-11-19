import type {
  ChatQueueJobsSnapshot,
  ChatQueueJobsVersion
} from '../../../../../shared/chatQueueTypes'

interface ChatQueueJobsSyncRun {
  minimum?: ChatQueueJobsVersion
  confirmedEpoch?: string
  retiredEpochs: Set<string>
  pending?: Promise<void>
  followUp: boolean
  stopListening?: () => void
}

interface ChatQueueJobsSync {
  start(): () => void
  refresh(followInFlight?: boolean): Promise<void>
}

export function createChatQueueJobsSync(deps: {
  read(): Promise<ChatQueueJobsSnapshot>
  listen(handler: (version: ChatQueueJobsVersion) => void): () => void
  publish(snapshot: ChatQueueJobsSnapshot): void
  onError(error: unknown): void
}): ChatQueueJobsSync {
  let current: ChatQueueJobsSyncRun | undefined

  function reportError(error: unknown): void {
    try {
      deps.onError(error)
    } catch {
      // Reporting must not stop reconciliation.
    }
  }

  function observe(run: ChatQueueJobsSyncRun, version: ChatQueueJobsVersion): void {
    run.minimum = { epoch: version.epoch, revision: version.revision }
  }

  function accepts(
    run: ChatQueueJobsSyncRun,
    version: ChatQueueJobsVersion,
    startedEpoch: string | undefined
  ): boolean {
    if (run.retiredEpochs.has(version.epoch)) return false
    const floor = run.minimum
    if (!floor) return true
    if (floor.epoch === version.epoch) return version.revision >= floor.revision
    // Fence in-flight replies, but a new pull can discover another restart that
    // produced no notification. The prior confirmed epoch must never return.
    return floor.epoch === startedEpoch && version.epoch !== run.confirmedEpoch
  }

  function confirm(run: ChatQueueJobsSyncRun, snapshot: ChatQueueJobsSnapshot): void {
    for (const epoch of [run.confirmedEpoch, run.minimum?.epoch]) {
      if (epoch && epoch !== snapshot.epoch) run.retiredEpochs.add(epoch)
    }
    observe(run, snapshot)
    run.confirmedEpoch = snapshot.epoch
  }

  async function pull(run: ChatQueueJobsSyncRun): Promise<void> {
    do {
      run.followUp = false
      const startedEpoch = run.minimum?.epoch
      try {
        const snapshot = await deps.read()
        if (current !== run) return
        if (accepts(run, snapshot, startedEpoch)) {
          confirm(run, snapshot)
          // A read can confirm durable data after a notification or its write receipt was lost.
          deps.publish(snapshot)
        }
      } catch (error) {
        if (current === run) reportError(error)
      }
    } while (current === run && run.followUp)
  }

  function refreshRun(run: ChatQueueJobsSyncRun): Promise<void> {
    return (run.pending ??= Promise.resolve()
      .then(() => {
        if (current === run) return pull(run)
        return undefined
      })
      .finally(() => {
        run.pending = undefined
        if (current === run && run.followUp) void refreshRun(run)
      }))
  }

  function handleVersion(run: ChatQueueJobsSyncRun, version: ChatQueueJobsVersion): void {
    if (current !== run || run.retiredEpochs.has(version.epoch)) return
    if (run.minimum?.epoch === version.epoch && version.revision <= run.minimum.revision) return
    if (version.epoch === run.confirmedEpoch && version.epoch !== run.minimum?.epoch) return
    observe(run, version)
    if (run.pending) run.followUp = true
    else void refreshRun(run)
  }

  function stop(run: ChatQueueJobsSyncRun): void {
    if (current !== run) return
    current = undefined
    try {
      run.stopListening?.()
    } catch (error) {
      reportError(error)
    }
  }

  return {
    start() {
      if (current) stop(current)
      const run: ChatQueueJobsSyncRun = { retiredEpochs: new Set(), followUp: false }
      current = run
      try {
        run.stopListening = deps.listen((version) => handleVersion(run, version))
      } catch (error) {
        reportError(error)
      }
      void refreshRun(run)
      return () => stop(run)
    },
    refresh(followInFlight = true) {
      if (!current) return Promise.resolve()
      if (followInFlight && current.pending) current.followUp = true
      return refreshRun(current)
    }
  }
}
