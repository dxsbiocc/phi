import { randomUUID } from 'node:crypto'
import type { NotebookAiGenerationJob } from '../../../shared/notebookAiJobTypes'

const MAX_FINISHED_JOBS = 50
const MAX_PROMPT_LENGTH = 4_000
const MAX_SOURCE_PREVIEW_LENGTH = 20_000
const MAX_ERROR_LENGTH = 4_000

type JobProgress = Partial<
  Pick<
    NotebookAiGenerationJob,
    'notebookPath' | 'notebookName' | 'model' | 'sourcePreview' | 'cellCount'
  >
>

export interface NotebookAiGenerationJobHandle {
  readonly id: string
  update(
    phase: Exclude<NotebookAiGenerationJob['phase'], 'completed' | 'failed'>,
    progress?: JobProgress
  ): void
  complete(progress: Pick<NotebookAiGenerationJob, 'sourcePreview' | 'cellCount'>): void
  fail(error: unknown): void
}

/** Observable attempts; temporary agent sessions retain their existing lifecycle. */
export class NotebookAiGenerationJobs {
  private readonly jobs: NotebookAiGenerationJob[] = []

  constructor(private readonly now: () => Date = () => new Date()) {}

  list(): NotebookAiGenerationJob[] {
    // New attempts are inserted first, including attempts with identical start timestamps.
    return this.jobs.map((job) => ({ ...job }))
  }

  begin(
    input: Pick<
      NotebookAiGenerationJob,
      'projectCwd' | 'notebookPath' | 'notebookName' | 'model' | 'prompt'
    > & {
      requestId?: string
    }
  ): NotebookAiGenerationJobHandle {
    const id = randomUUID()
    const timestamp = this.now().toISOString()
    const job: NotebookAiGenerationJob = {
      ...input,
      id,
      requestId: input.requestId || id,
      prompt: input.prompt.slice(0, MAX_PROMPT_LENGTH),
      state: 'running',
      phase: 'preparing',
      startedAt: timestamp,
      updatedAt: timestamp
    }
    this.jobs.unshift(job)

    const applyProgress = (progress: JobProgress): void => {
      Object.assign(job, progress)
      if (progress.sourcePreview !== undefined) {
        job.sourcePreview = progress.sourcePreview.slice(0, MAX_SOURCE_PREVIEW_LENGTH)
      }
      job.updatedAt = this.now().toISOString()
    }
    const finish = (state: 'completed' | 'failed'): void => {
      job.state = state
      job.phase = state
      job.completedAt = this.now().toISOString()
      job.updatedAt = job.completedAt
      this.prune()
    }
    return {
      id,
      update: (phase, progress = {}) => {
        if (job.state !== 'running') return
        job.phase = phase
        applyProgress(progress)
      },
      complete: (progress) => {
        if (job.state !== 'running') return
        applyProgress(progress)
        finish('completed')
      },
      fail: (error) => {
        if (job.state !== 'running') return
        job.error = (error instanceof Error ? error.message : String(error)).slice(
          0,
          MAX_ERROR_LENGTH
        )
        finish('failed')
      }
    }
  }

  private prune(): void {
    let finished = 0
    for (let index = 0; index < this.jobs.length; index += 1) {
      if (this.jobs[index].state === 'running') continue
      finished += 1
      if (finished > MAX_FINISHED_JOBS) {
        this.jobs.splice(index, 1)
        index -= 1
      }
    }
  }
}
