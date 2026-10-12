import { randomUUID } from 'node:crypto'

import {
  REMOTE_JUPYTER_JOB_MAX_ENTRIES,
  type RemoteJupyterStartJob,
  type RemoteJupyterStartJobEntry
} from '../../../shared/remoteJupyterJobTypes'
import type { JupyterRuntimeState } from './jupyter-runtime-backend'

const MAX_FINISHED_JOBS = 20

const STATE_STEPS: Partial<Record<JupyterRuntimeState, string>> = {
  allocating_ports: '分配远端端口',
  starting_lease: '通过 SSH 启动 Jupyter Server',
  probing_through_tunnel: '经 SSH 隧道等待 Jupyter 就绪',
  ready: 'Jupyter Server 已就绪',
  cleaning: '清理本次启动留下的远端进程',
  reconciling: '确认旧 Jupyter 是否已退出',
  disconnected: 'SSH 连接已断开'
}

export interface RemoteJupyterStartJobHandle {
  readonly id: string
  step(text: string): void
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
      phase: '准备启动',
      startedAt: this.now().toISOString(),
      entries: []
    }
    this.jobs.unshift(job)
    this.prune()
    const append = (kind: RemoteJupyterStartJobEntry['kind'], text: string): void => {
      const trimmed = text.trimEnd()
      if (!trimmed) return
      job.entries.push({ at: this.now().toISOString(), kind, text: trimmed })
      if (job.entries.length > REMOTE_JUPYTER_JOB_MAX_ENTRIES) {
        job.entries.splice(0, job.entries.length - REMOTE_JUPYTER_JOB_MAX_ENTRIES)
      }
    }
    const finish = (state: RemoteJupyterStartJob['state']): void => {
      job.state = state
      job.finishedAt = this.now().toISOString()
      this.prune()
    }
    const running = (): boolean => job.state === 'running'
    return {
      id: job.id,
      step: (text) => {
        if (!running()) return
        job.phase = text
        append('step', text)
        this.emit(job)
      },
      output: (line) => {
        if (!running()) return
        append('output', line)
        this.emit(job)
      },
      state: (state, message) => {
        if (!running()) return
        const step = STATE_STEPS[state]
        if (!step) return
        job.phase = step
        append('step', message ? `${step}：${message}` : step)
        this.emit(job)
      },
      succeed: () => {
        if (!running()) return
        job.phase = 'Jupyter Server 已就绪'
        finish('ready')
        this.emit(job)
      },
      fail: (error) => {
        if (!running()) return
        const text = describeRemoteJupyterError(error)
        job.error = text
        job.phase = '启动失败'
        append('error', text)
        finish('failed')
        this.emit(job)
      },
      cancel: () => {
        if (!running()) return
        job.phase = '已停止'
        append('step', '已停止启动')
        finish('cancelled')
        this.emit(job)
      }
    }
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
    const message = current instanceof Error ? current.message : String(current)
    if (message && !parts.includes(message)) parts.push(message)
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join('：') || '未知错误'
}
