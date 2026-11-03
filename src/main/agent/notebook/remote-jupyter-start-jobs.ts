import { randomUUID } from 'node:crypto'

import {
  REMOTE_JUPYTER_JOB_MAX_ENTRIES,
  type RemoteJupyterStartJob,
  type RemoteJupyterStartJobEntry,
  type RemoteJupyterStartJobEntryCode,
  type RemoteJupyterStartJobPhaseCode,
  type RemoteJupyterStartJobStepMetadata,
  type RemoteJupyterStartJobStepCode,
  type RemoteJupyterStartJobTextParams
} from '../../../shared/remoteJupyterJobTypes'
import type { JupyterRuntimeState } from './jupyter-runtime-backend'

const MAX_FINISHED_JOBS = 20

type StepMetadata = {
  code: RemoteJupyterStartJobEntryCode
  params?: RemoteJupyterStartJobTextParams
}

const STATE_STEPS: Partial<
  Record<JupyterRuntimeState, { text: string; code: RemoteJupyterStartJobStepCode }>
> = {
  allocating_ports: { text: 'Allocating remote port', code: 'allocating_ports' },
  starting_lease: { text: 'Starting Jupyter Server over SSH', code: 'starting_lease' },
  probing_through_tunnel: {
    text: 'Waiting for Jupyter through the SSH tunnel',
    code: 'probing_through_tunnel'
  },
  ready: { text: 'Jupyter Server is ready', code: 'ready' },
  cleaning: { text: 'Cleaning up remote processes from this startup', code: 'cleaning' },
  reconciling: { text: 'Checking whether the old Jupyter has exited', code: 'reconciling' },
  disconnected: { text: 'SSH connection disconnected', code: 'disconnected' }
}

export interface RemoteJupyterStartJobHandle {
  readonly id: string
  step(text: string, metadata?: RemoteJupyterStartJobStepMetadata): void
  output(line: string): void
  state(state: JupyterRuntimeState, message?: string): void
  succeed(): void
  fail(error: unknown): void
  cancel(): void
}

/** Startup attempts of remote Jupyter servers, kept in memory for the background jobs panel. */
export class RemoteJupyterStartJobs {
  private readonly jobs: RemoteJupyterStartJob[] = []
  private readonly listeners = new Set<(job: RemoteJupyterStartJob) => void>()

  constructor(private readonly now: () => Date = () => new Date()) {}

  list(): RemoteJupyterStartJob[] {
    return this.jobs.map((job) => ({ ...job, entries: [...job.entries] }))
  }

  subscribe(listener: (job: RemoteJupyterStartJob) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  begin(input: {
    projectId: string
    projectName: string
    serverLabel: string
  }): RemoteJupyterStartJobHandle {
    const job: RemoteJupyterStartJob = {
      id: randomUUID(),
      ...input,
      state: 'running',
      phase: 'Preparing to start',
      phaseCode: 'preparing',
      startedAt: this.now().toISOString(),
      entries: []
    }
    this.jobs.unshift(job)
    this.prune()
    const finish = (state: RemoteJupyterStartJob['state']): void => {
      job.state = state
      job.finishedAt = this.now().toISOString()
      this.prune()
    }
    const running = (): boolean => job.state === 'running'
    return {
      id: job.id,
      step: (text, metadata) => {
        if (!running()) return
        this.setPhase(job, text, metadata?.code, metadata?.params)
        this.append(job, 'step', text, metadata)
        this.emit(job)
      },
      output: (line) => {
        if (!running()) return
        this.append(job, 'output', line)
        this.emit(job)
      },
      state: (state, message) => {
        if (!running()) return
        const step = STATE_STEPS[state]
        if (!step) return
        this.setPhase(job, step.text, step.code)
        this.append(job, 'step', message ? `${step.text}: ${message}` : step.text, {
          code: step.code,
          ...(message ? { params: { detail: message } } : {})
        })
        this.emit(job)
      },
      succeed: () => {
        if (!running()) return
        this.setPhase(job, 'Jupyter Server is ready', 'ready')
        finish('ready')
        this.emit(job)
      },
      fail: (error) => {
        if (!running()) return
        const text = describeRemoteJupyterError(error)
        job.error = text
        this.setPhase(job, 'Startup failed', 'failed')
        this.append(job, 'error', text)
        finish('failed')
        this.emit(job)
      },
      cancel: () => {
        if (!running()) return
        this.setPhase(job, 'Stopped', 'cancelled')
        this.append(job, 'step', 'Startup stopped', { code: 'startup_cancelled' })
        finish('cancelled')
        this.emit(job)
      }
    }
  }

  private append(
    job: RemoteJupyterStartJob,
    kind: RemoteJupyterStartJobEntry['kind'],
    text: string,
    metadata?: StepMetadata
  ): void {
    const trimmed = text.trimEnd()
    if (!trimmed) return
    job.entries.push({ at: this.now().toISOString(), kind, text: trimmed, ...metadata })
    if (job.entries.length > REMOTE_JUPYTER_JOB_MAX_ENTRIES) {
      job.entries.splice(0, job.entries.length - REMOTE_JUPYTER_JOB_MAX_ENTRIES)
    }
  }

  private setPhase(
    job: RemoteJupyterStartJob,
    text: string,
    code?: RemoteJupyterStartJobPhaseCode,
    params?: RemoteJupyterStartJobTextParams
  ): void {
    job.phase = text
    if (code) job.phaseCode = code
    else delete job.phaseCode
    if (params) job.phaseParams = params
    else delete job.phaseParams
  }

  private prune(): void {
    let finished = 0
    for (let index = 0; index < this.jobs.length; index += 1) {
      if (this.jobs[index]?.state === 'running') continue
      finished += 1
      if (finished > MAX_FINISHED_JOBS) {
        this.jobs.splice(index, 1)
        index -= 1
      }
    }
  }

  private emit(job: RemoteJupyterStartJob): void {
    const snapshot = { ...job, entries: [...job.entries] }
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // A broken observer must not stop the startup it is watching.
      }
    }
  }
}

/** The error and its causes, which often hold the actual reason (exited early, timed out). */
export function describeRemoteJupyterError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    // Preserve an empty Error message so the existing unknown-error fallback still applies.
    const message = current instanceof Error ? current.message : String(current)
    if (message && !parts.includes(message)) parts.push(message)
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(': ') || 'Unknown error'
}
