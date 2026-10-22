import { jobsCopy } from '../lib/jobsCopy'
import { useEffect, useSyncExternalStore } from 'react'

import type {
  BackgroundAgentJob,
  BackgroundShellJob
} from '../../../../../shared/backgroundJobTypes'
import type { EnvironmentBuild } from '../../../../../shared/environmentBuildTypes'
import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import type { RemoteJupyterStartJob } from '../../../../../shared/remoteJupyterJobTypes'
import type { NotebookAiGenerationJob } from '../../../../../shared/notebookAiJobTypes'
import type { RemoteProjectUploadJob } from '../../../../../shared/remoteProjectUploadTypes'
import type { WrapperRun } from '../../../../../shared/wrapperTypes'
import { BackgroundJobHistory, backgroundJobHistoryStorage } from '../lib/backgroundJobHistory'
import { selectBackgroundJobs, type UnifiedBackgroundJob } from '../lib/backgroundJobs'

const REFRESH_MS = 2000

export type BackgroundJobsData = {
  agentJobs: BackgroundAgentJob[]
  shellJobs: BackgroundShellJob[]
  wrapperRuns: WrapperRun[]
  environmentBuilds: EnvironmentBuild[]
  connectorJobs: McpConnectorSetupProgress[]
  uploadJobs: RemoteProjectUploadJob[]
  jupyterJobs: RemoteJupyterStartJob[]
  notebookAiJobs: NotebookAiGenerationJob[]
}

type JobLists = { active: UnifiedBackgroundJob[]; recent: UnifiedBackgroundJob[] }
type Snapshot = {
  data: BackgroundJobsData
  jobs: JobLists
  loaded: boolean
  error: string
  nowMs: number
}

const EMPTY: BackgroundJobsData = {
  agentJobs: [],
  shellJobs: [],
  wrapperRuns: [],
  environmentBuilds: [],
  connectorJobs: [],
  uploadJobs: [],
  jupyterJobs: [],
  notebookAiJobs: []
}

function upsertBy<T>(current: readonly T[], next: T, same: (item: T) => boolean): T[] {
  const index = current.findIndex(same)
  if (index === -1) return [next, ...current]
  const copy = current.slice()
  copy[index] = next
  return copy
}

function listOrEmpty<T>(list: (() => Promise<T[]>) | undefined): Promise<T[]> {
  return typeof list === 'function' ? list() : Promise.resolve([])
}

function liveJobs(data: BackgroundJobsData): ReturnType<typeof selectBackgroundJobs> {
  return selectBackgroundJobs(
    data.agentJobs,
    data.wrapperRuns,
    { maxRecent: Number.MAX_SAFE_INTEGER },
    data.shellJobs,
    data.environmentBuilds,
    data.connectorJobs,
    data.uploadJobs,
    data.jupyterJobs,
    data.notebookAiJobs
  )
}

/** One source poller per renderer, retained by the app even when the panel is closed. */
class BackgroundJobsStore {
  private readonly history = new BackgroundJobHistory(backgroundJobHistoryStorage())
  private state: Snapshot = {
    data: EMPTY,
    jobs: this.history.select({ active: [], recent: [] }),
    loaded: false,
    error: '',
    nowMs: Date.now()
  }
  private readonly listeners = new Set<() => void>()
  private references = 0
  private timer: number | undefined
  private refreshing = false
  private generation = 0
  private unsubscribes: Array<(() => void) | undefined> | undefined

  getSnapshot = (): Snapshot => this.state

  retain = (): (() => void) => {
    this.references += 1
    if (this.references === 1) {
      this.generation += 1
      void this.refresh()
      this.timer = window.setInterval(() => void this.refresh(), REFRESH_MS)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.references -= 1
      if (this.references !== 0) return
      this.generation += 1
      window.clearInterval(this.timer)
      this.timer = undefined
      for (const unsubscribe of this.unsubscribes ?? []) unsubscribe?.()
      this.unsubscribes = undefined
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    const release = this.retain()
    return () => {
      this.listeners.delete(listener)
      release()
    }
  }

  setError = (error: string): void => {
    this.state = { ...this.state, error }
    this.emit()
  }

  clearCompleted = (): void => {
    this.history.clearCompleted(liveJobs(this.state.data).recent)
    this.publish(this.state.data)
  }

  refresh = async (): Promise<void> => {
    if (this.refreshing) return
    this.refreshing = true
    const generation = this.generation
    try {
      const api = window.api
      if (typeof api?.listAgentJobs !== 'function') {
        this.state = { ...this.state, error: jobsCopy.restartPhiToViewBackgroundJobs, loaded: true }
        this.emit()
        return
      }
      this.attachEvents(api)
      const results = await Promise.allSettled([
        api.listAgentJobs(),
        listOrEmpty(api.listShellJobs),
        api.listWrapperRuns(),
        listOrEmpty(api.listEnvironmentBuilds),
        listOrEmpty(api.listLocalConnectorJobs),
        listOrEmpty(api.listRemoteProjectUploads),
        listOrEmpty(api.listRemoteJupyterJobs),
        listOrEmpty(api.listNotebookAiGenerationJobs)
      ] as const)
      if (generation !== this.generation) return
      const [agents, shells, wrappers, builds, connectors, uploads, jupyter, notebookAi] = results
      const current = this.state.data
      this.state = {
        ...this.state,
        loaded: true,
        error: results.some((result) => result.status === 'rejected')
          ? jobsCopy.someJobStatusesAreTemporarilyUnavailableTheyWillRetryAutomatically
          : ''
      }
      this.publish({
        agentJobs: agents.status === 'fulfilled' ? agents.value : current.agentJobs,
        shellJobs: shells.status === 'fulfilled' ? shells.value : current.shellJobs,
        wrapperRuns: wrappers.status === 'fulfilled' ? wrappers.value : current.wrapperRuns,
        environmentBuilds: builds.status === 'fulfilled' ? builds.value : current.environmentBuilds,
        connectorJobs: connectors.status === 'fulfilled' ? connectors.value : current.connectorJobs,
        uploadJobs: uploads.status === 'fulfilled' ? uploads.value : current.uploadJobs,
        jupyterJobs: jupyter.status === 'fulfilled' ? jupyter.value : current.jupyterJobs,
        notebookAiJobs:
          notebookAi.status === 'fulfilled' ? notebookAi.value : current.notebookAiJobs
      })
    } finally {
      this.refreshing = false
      if (generation !== this.generation && this.references > 0) void this.refresh()
    }
  }

  private publish(data: BackgroundJobsData): void {
    const live = liveJobs(data)
    this.history.observe([...live.active, ...live.recent])
    this.state = { ...this.state, data, jobs: this.history.select(live), nowMs: Date.now() }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private attachEvents(api: Window['api']): void {
    if (this.unsubscribes) return
    this.unsubscribes = [
      api.onEnvironmentBuildsChanged?.((build) =>
        this.publish({
          ...this.state.data,
          environmentBuilds: upsertBy(
            this.state.data.environmentBuilds,
            build,
            (item) => item.envId === build.envId
          )
        })
      ),
      api.onMcpConnectorSetupChanged?.((setup) => {
        if (setup.kind !== 'local-stdio') return
        this.publish({
          ...this.state.data,
          connectorJobs: upsertBy(
            this.state.data.connectorJobs,
            setup,
            (item) => item.id === setup.id
          )
        })
      }),
      api.onRemoteProjectUploadsChanged?.((job) =>
        this.publish({
          ...this.state.data,
          uploadJobs: upsertBy(this.state.data.uploadJobs, job, (item) => item.id === job.id)
        })
      ),
      api.onRemoteJupyterJobsChanged?.((job) =>
        this.publish({
          ...this.state.data,
          jupyterJobs: upsertBy(this.state.data.jupyterJobs, job, (item) => item.id === job.id)
        })
      )
    ]
  }
}

let shared: BackgroundJobsStore | undefined
function jobsStore(): BackgroundJobsStore {
  return (shared ??= new BackgroundJobsStore())
}

type JupyterStartupOverview = {
  signature: string
  projectIds: readonly string[]
}

let jupyterStartupOverview: JupyterStartupOverview = { signature: '[]', projectIds: [] }

function currentJupyterStartupOverview(): JupyterStartupOverview {
  const jobs = jobsStore().getSnapshot().data.jupyterJobs
  const signature = JSON.stringify(
    jobs.map(({ id, projectId, state, phase }) => [id, projectId, state, phase])
  )
  if (signature !== jupyterStartupOverview.signature) {
    jupyterStartupOverview = {
      signature,
      projectIds: [...new Set(jobs.map((job) => job.projectId))]
    }
  }
  return jupyterStartupOverview
}

/** Changes only when a Jupyter attempt appears or changes phase, not on every log line. */
export function useJupyterStartupOverview(): JupyterStartupOverview {
  const store = jobsStore()
  return useSyncExternalStore(
    store.subscribe,
    currentJupyterStartupOverview,
    () => jupyterStartupOverview
  )
}

/** Keeps terminal snapshots up to date without subscribing the application to polling renders. */
export function useBackgroundJobRetention(): void {
  useEffect(() => jobsStore().retain(), [])
}

/** Uses the same shared poller as the panel without subscribing the app shell. */
export function refreshBackgroundJobs(): Promise<void> {
  return jobsStore().refresh()
}

/** Subscribe the toolbar only to count changes, rather than every polling timestamp. */
export function useActiveBackgroundJobCount(): number {
  const store = jobsStore()
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().jobs.active.length,
    () => 0
  )
}

export function useBackgroundJobsData(): Snapshot & {
  refresh: () => Promise<void>
  clearCompleted: () => void
  setError: (error: string) => void
} {
  const store = jobsStore()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return {
    ...snapshot,
    refresh: store.refresh,
    clearCompleted: store.clearCompleted,
    setError: store.setError
  }
}
