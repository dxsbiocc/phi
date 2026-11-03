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

/** A step that was retried or repeated counts once, by its latest attempt. */
export function workflowStepCounts(jobs: readonly WrapperJob[]): {
  completed: number
  failed: number
} {
  const latest = new Map<string, WrapperJob>()
  for (const job of jobs) {
    const step = job.run.workflow?.step ?? job.run.runId
    const previous = latest.get(step)
    if (!previous || job.run.createdAt.localeCompare(previous.run.createdAt) >= 0)
      latest.set(step, job)
  }
  const states = [...latest.values()].map((job) => job.run.state)
  return {
    completed: states.filter((state) => state === 'completed').length,
    failed: states.filter((state) => state === 'failed' || state === 'lost').length
  }
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
    group.totalSteps = Math.max(group.totalSteps, workflow.totalSteps ?? 0, group.jobs.length)
    if (workflow.totalSteps !== undefined)
      group.expectedSteps = Math.max(group.expectedSteps ?? 0, workflow.totalSteps)
  }
  for (const group of groups.values()) {
    group.jobs.sort((left, right) => left.run.createdAt.localeCompare(right.run.createdAt))
    if (
      group.expectedSteps !== undefined &&
      group.jobs.length < group.expectedSteps &&
      !group.jobs.some((job) => ['failed', 'lost', 'cancelled'].includes(job.run.state))
    )
      group.active = true
  }
  return [...groups.values(), ...singles].sort((left, right) =>
    right.timestamp.localeCompare(left.timestamp)
  )
}
