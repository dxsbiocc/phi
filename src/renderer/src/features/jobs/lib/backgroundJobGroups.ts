import type { UnifiedBackgroundJob } from './backgroundJobs'

export type BackgroundJobDisplayItem =
  | {
      kind: 'job'
      key: string
      active: boolean
      timestamp: string
      job: UnifiedBackgroundJob
    }
  | {
      kind: 'workflow'
      key: string
      active: boolean
      timestamp: string
      title: string
      totalSteps: number
      expectedSteps?: number
      jobs: Extract<UnifiedBackgroundJob, { kind: 'wrapper' }>[]
    }

type WrapperJob = Extract<UnifiedBackgroundJob, { kind: 'wrapper' }>

export interface WorkflowStepSummary {
  /** One job per step: its latest attempt. */
  latest: WrapperJob[]
  completed: number
  failed: number
  cancelled: number
}

function latestAttemptKey(job: WrapperJob): string {
  return job.run.workflow?.step ?? job.run.runId
}

function compareAttempts(left: WrapperJob, right: WrapperJob): number {
  const byCreatedAt = left.run.createdAt.localeCompare(right.run.createdAt)
  return byCreatedAt !== 0 ? byCreatedAt : left.run.runId.localeCompare(right.run.runId)
}

/**
 * Every workflow decision uses one latest attempt per step. A repeated step must not inflate the
 * total, and a historical failure must not outlive the attempt that later succeeded. Runs without
 * a step keep their run id as the step identity so independent runs stay distinct.
 */
export function workflowStepSummary(jobs: readonly WrapperJob[]): WorkflowStepSummary {
  const latestByStep = new Map<string, WrapperJob>()
  for (const job of jobs) {
    const step = latestAttemptKey(job)
    const previous = latestByStep.get(step)
    if (!previous || compareAttempts(previous, job) < 0) latestByStep.set(step, job)
  }
  const latest = [...latestByStep.values()].sort(compareAttempts)
  const states = latest.map((job) => job.run.state)
  return {
    latest,
    completed: states.filter((state) => state === 'completed').length,
    failed: states.filter((state) => state === 'failed' || state === 'lost').length,
    cancelled: states.filter((state) => state === 'cancelled').length
  }
}

/** A step that was retried or repeated counts once, by its latest attempt. */
export function workflowStepCounts(jobs: readonly WrapperJob[]): {
  completed: number
  failed: number
} {
  const summary = workflowStepSummary(jobs)
  return { completed: summary.completed, failed: summary.failed }
}

function applyWorkflowProgress(
  group: Extract<BackgroundJobDisplayItem, { kind: 'workflow' }>
): void {
  group.jobs.sort(compareAttempts)
  const summary = workflowStepSummary(group.jobs)
  group.totalSteps = Math.max(group.expectedSteps ?? 0, summary.latest.length)
  if (
    group.expectedSteps !== undefined &&
    summary.latest.length < group.expectedSteps &&
    summary.failed === 0 &&
    summary.cancelled === 0
  )
    group.active = true
}

/** Only an explicit, persisted workflow identity can join independent runs. */
export function groupBackgroundJobs(
  jobs: readonly UnifiedBackgroundJob[]
): BackgroundJobDisplayItem[] {
  const groups = new Map<string, Extract<BackgroundJobDisplayItem, { kind: 'workflow' }>>()
  const singles: BackgroundJobDisplayItem[] = []
  for (const job of jobs) {
    if (job.kind !== 'wrapper' || !job.run.workflow?.id || !job.run.workflow.name) {
      singles.push({ kind: 'job', key: job.key, active: job.active, timestamp: job.timestamp, job })
      continue
    }
    const workflow = job.run.workflow
    const key = `workflow:${workflow.id}`
    let group = groups.get(key)
    if (!group) {
      group = {
        kind: 'workflow',
        key,
        active: false,
        timestamp: job.timestamp,
        title: workflow.name,
        totalSteps: 0,
        jobs: []
      }
      groups.set(key, group)
    }
    group.jobs.push(job)
    group.active ||= job.active
    if (job.timestamp > group.timestamp) group.timestamp = job.timestamp
    if (workflow.totalSteps !== undefined)
      group.expectedSteps = Math.max(group.expectedSteps ?? 0, workflow.totalSteps)
  }
  for (const group of groups.values()) applyWorkflowProgress(group)
  return [...groups.values(), ...singles].sort((left, right) =>
    right.timestamp.localeCompare(left.timestamp)
  )
}
