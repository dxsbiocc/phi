import type {
  PrepareRemoteProjectUploadInput,
  RemoteProjectUploadJob,
  StartRemoteProjectUploadOptions
} from '../../../shared/remoteProjectUploadTypes'
import type { RemoteSshSession } from '../wrappers/remote-ssh-session'

import { RemoteProjectUploadManager } from './manager'

export interface RemoteProjectUploadBinding {
  session: RemoteSshSession
  remoteProjectRoot: string
  canonicalRemoteProjectRoot: string
  hostKey: string
  workspaceId: string
}

export interface RemoteProjectUploadServiceOptions {
  connectProject: (projectId: string) => Promise<RemoteProjectUploadBinding>
}

type ProjectEntry = {
  manager: RemoteProjectUploadManager
  session: RemoteSshSession
  unsubscribe: () => void
}

/** Owns per-project upload managers while exposing one global background-job surface. */
export class RemoteProjectUploadService {
  private readonly projects = new Map<string, Promise<ProjectEntry>>()
  private readonly owners = new Map<string, string>()
  private readonly completions = new Map<string, Promise<RemoteProjectUploadJob>>()
  private readonly listeners = new Set<(job: RemoteProjectUploadJob) => void>()

  constructor(private readonly options: RemoteProjectUploadServiceOptions) {}

  async prepare(
    projectId: string,
    input: PrepareRemoteProjectUploadInput
  ): Promise<RemoteProjectUploadJob> {
    const entry = await this.entry(projectId)
    const job = await entry.manager.prepare(input)
    this.owners.set(job.id, projectId)
    return job
  }

  async start(
    projectId: string,
    jobId: string,
    options: StartRemoteProjectUploadOptions = {}
  ): Promise<RemoteProjectUploadJob> {
    const entry = await this.owned(projectId, jobId)
    if (this.completions.has(jobId)) throw new Error('Upload job is already running')
    const completion = entry.manager.start(jobId, options)
    this.track(jobId, completion)
    return this.job(entry.manager, jobId)
  }

  async wait(projectId: string, jobId: string): Promise<RemoteProjectUploadJob> {
    const entry = await this.owned(projectId, jobId)
    const completion = this.completions.get(jobId)
    if (completion) return completion
    return this.job(entry.manager, jobId)
  }

  async cancel(jobId: string): Promise<RemoteProjectUploadJob> {
    const entry = await this.owner(jobId)
    return entry.manager.cancel(jobId)
  }

  async retry(jobId: string): Promise<RemoteProjectUploadJob> {
    const entry = await this.owner(jobId)
    if (this.completions.has(jobId)) throw new Error('Upload job is already running')
    const completion = entry.manager.retry(jobId)
    this.track(jobId, completion)
    return this.job(entry.manager, jobId)
  }

  async list(): Promise<RemoteProjectUploadJob[]> {
    const entries = await Promise.all([...this.projects.values()])
    return entries.flatMap((entry) => [...entry.manager.list()])
  }

  subscribe(listener: (job: RemoteProjectUploadJob) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async dispose(): Promise<void> {
    const entries = await Promise.allSettled([...this.projects.values()])
    for (const settled of entries) {
      if (settled.status !== 'fulfilled') continue
      for (const job of settled.value.manager.list()) {
        if (['queued', 'uploading', 'verifying'].includes(job.status)) {
          settled.value.manager.cancel(job.id)
        }
      }
      settled.value.unsubscribe()
      await settled.value.session.close().catch(() => undefined)
    }
    this.projects.clear()
    this.owners.clear()
    this.completions.clear()
  }

  private entry(projectId: string): Promise<ProjectEntry> {
    let pending = this.projects.get(projectId)
    if (pending) return pending
    pending = this.options.connectProject(projectId).then((binding) => {
      const manager = new RemoteProjectUploadManager(binding)
      const unsubscribe = manager.subscribe((job) => {
        for (const listener of this.listeners) listener(job)
      })
      return { manager, session: binding.session, unsubscribe }
    })
    this.projects.set(projectId, pending)
    void pending.catch(() => this.projects.delete(projectId))
    return pending
  }

  private async owned(projectId: string, jobId: string): Promise<ProjectEntry> {
    if (this.owners.get(jobId) !== projectId)
      throw new Error('Upload job does not belong to project')
    return this.entry(projectId)
  }

  private async owner(jobId: string): Promise<ProjectEntry> {
    const projectId = this.owners.get(jobId)
    if (!projectId) throw new Error('Upload job was not found')
    return this.entry(projectId)
  }

  private job(manager: RemoteProjectUploadManager, jobId: string): RemoteProjectUploadJob {
    const job = manager.list().find((candidate) => candidate.id === jobId)
    if (!job) throw new Error('Upload job was not found')
    return job
  }

  private track(jobId: string, completion: Promise<RemoteProjectUploadJob>): void {
    this.completions.set(jobId, completion)
    void completion.finally(() => {
      if (this.completions.get(jobId) === completion) this.completions.delete(jobId)
    })
  }
}
