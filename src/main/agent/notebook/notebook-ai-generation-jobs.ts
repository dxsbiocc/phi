import { randomUUID } from 'node:crypto'
import type { NotebookAiGenerationJob } from '../../../shared/notebookAiJobTypes'
import type { AnalysisNotebookGeneratedCell } from '../../../shared/notebookCodeGeneration'
import type { PhiAgentEventSummary } from '../engine/event-types'
import { NotebookAiActivity } from './notebook-ai-activity'

const MAX_FINISHED_JOBS = 50
const MAX_PROMPT_LENGTH = 4_000
const MAX_SOURCE_PREVIEW_LENGTH = 20_000
const MAX_PREVIEW_CELLS = 100
const MAX_ERROR_LENGTH = 4_000

function boundedPreviewCells(
  cells: AnalysisNotebookGeneratedCell[]
): AnalysisNotebookGeneratedCell[] {
  let remaining = MAX_SOURCE_PREVIEW_LENGTH
  const preview: AnalysisNotebookGeneratedCell[] = []
  for (const cell of cells) {
    if (remaining <= 0 || preview.length >= MAX_PREVIEW_CELLS) break
    const source = cell.source.slice(0, remaining)
    preview.push({ ...cell, source })
    remaining -= source.length + 2
  }
  return preview
}

type JobProgress = Partial<
  Pick<
    NotebookAiGenerationJob,
    'notebookPath' | 'notebookName' | 'model' | 'sourcePreview' | 'previewCells' | 'cellCount'
  >
>

export interface NotebookAiGenerationJobHandle {
  readonly id: string
  observe(summary: PhiAgentEventSummary): void
  update(
    phase: Exclude<NotebookAiGenerationJob['phase'], 'completed' | 'failed'>,
    progress?: JobProgress
  ): void
  complete(
    progress: Pick<NotebookAiGenerationJob, 'sourcePreview' | 'previewCells' | 'cellCount'>
  ): void
  fail(error: unknown): void
}

/** Observable attempts; temporary agent sessions retain their existing lifecycle. */
export class NotebookAiGenerationJobs {
  private readonly jobs: NotebookAiGenerationJob[] = []

  constructor(private readonly now: () => Date = () => new Date()) {}

  list(): NotebookAiGenerationJob[] {
    // New attempts are inserted first, including attempts with identical start timestamps.
    return this.jobs.map((job) => ({
      ...job,
      ...(job.entries ? { entries: job.entries.map((entry) => ({ ...entry })) } : {}),
      ...(job.previewCells ? { previewCells: job.previewCells.map((cell) => ({ ...cell })) } : {})
    }))
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
    const activity = new NotebookAiActivity(() => this.now().toISOString())
    activity.phase('preparing')
    const job: NotebookAiGenerationJob = {
      ...input,
      id,
      requestId: input.requestId || id,
      prompt: input.prompt.slice(0, MAX_PROMPT_LENGTH),
      state: 'running',
      phase: 'preparing',
      startedAt: timestamp,
      updatedAt: timestamp,
      entries: activity.entries
    }
    this.jobs.unshift(job)

    const applyProgress = (progress: JobProgress): void => {
      Object.assign(job, progress)
      if (progress.sourcePreview !== undefined) {
        job.sourcePreview = progress.sourcePreview.slice(0, MAX_SOURCE_PREVIEW_LENGTH)
      }
      if (progress.previewCells !== undefined) {
        job.previewCells = boundedPreviewCells(progress.previewCells)
      }
      job.updatedAt = this.now().toISOString()
    }
    const finish = (state: 'completed' | 'failed'): void => {
      activity.finish(state === 'failed')
      activity.phase(state)
      job.state = state
      job.phase = state
      job.completedAt = this.now().toISOString()
      job.updatedAt = job.completedAt
      this.prune()
    }
    return {
      id,
      observe: (summary) => {
        if (job.state !== 'running' || !activity.observe(summary)) return
        if (job.phase === 'waiting' || job.phase === 'preparing') {
          job.phase = 'generating'
          activity.phase('generating')
        }
        job.updatedAt = this.now().toISOString()
      },
      update: (phase, progress = {}) => {
        if (job.state !== 'running') return
        if (job.phase !== phase) activity.phase(phase)
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
