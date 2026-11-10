import type {
  PluginInstallAction,
  PluginInstallFailure,
  PluginInstallJob
} from '../../../shared/pluginInstallJobTypes'

export interface PluginInstallStartInput {
  pluginId: string
  title: string
  version: string
  action: PluginInstallAction
}

export interface PluginInstallJobHandle {
  readonly job: PluginInstallJob
  succeed(): void
  fail(failure: PluginInstallFailure): void
}

export interface PluginInstallJobsOptions {
  now?: () => Date
  /** Finished attempts retained for the panel; running attempts are never dropped. */
  maxFinished?: number
}

const DEFAULT_MAX_FINISHED = 50

/**
 * In-memory registry for Phi Plugin installations and upgrades.
 *
 * One running attempt per plugin: a second concurrent start for the same plugin
 * is rejected so the panel cannot show contradictory states. A new attempt
 * replaces the previous finished record for that plugin; durable history comes
 * from the renderer's background job history instead.
 */
export class PluginInstallJobs {
  private jobs: PluginInstallJob[] = []
  private sequence = 0
  private readonly now: () => Date
  private readonly maxFinished: number

  constructor(options: PluginInstallJobsOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.maxFinished = Math.max(1, options.maxFinished ?? DEFAULT_MAX_FINISHED)
  }

  list(): PluginInstallJob[] {
    return this.jobs.map((job) => ({ ...job }))
  }

  /** Returns `undefined` when the same plugin is already installing or upgrading. */
  begin(input: PluginInstallStartInput): PluginInstallJobHandle | undefined {
    if (this.jobs.some((job) => job.pluginId === input.pluginId && job.state === 'running')) {
      return undefined
    }
    this.jobs = this.jobs.filter((job) => job.pluginId !== input.pluginId)
    this.sequence += 1
    const job: PluginInstallJob = {
      id: `plugin-install-${this.sequence}`,
      pluginId: input.pluginId,
      title: input.title,
      version: input.version,
      action: input.action,
      state: 'running',
      startedAt: this.now().toISOString()
    }
    this.jobs.unshift(job)
    return {
      job,
      succeed: () => this.finish(job, 'succeeded'),
      fail: (failure) => this.finish(job, 'failed', failure)
    }
  }

  private finish(
    job: PluginInstallJob,
    state: 'succeeded' | 'failed',
    failure?: PluginInstallFailure
  ): void {
    if (job.state !== 'running') return
    job.state = state
    job.finishedAt = this.now().toISOString()
    if (failure) job.failure = failure
    const finished = this.jobs.filter((item) => item.state !== 'running')
    for (const stale of finished.slice(this.maxFinished)) {
      this.jobs = this.jobs.filter((item) => item !== stale)
    }
  }
}

export function createPluginInstallJobs(options: PluginInstallJobsOptions = {}): PluginInstallJobs {
  return new PluginInstallJobs(options)
}
