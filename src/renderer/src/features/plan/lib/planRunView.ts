import {
  PLAN_RUN_PAUSE_REASONS,
  PLAN_RUN_STATUSES,
  PLAN_STEP_STATUSES,
  type PlanRunPause,
  type PlanRunState,
  type PlanRunTimelineSnapshot,
  type PlanRunTimelineStepSnapshot,
  type PlanStep,
  type PlanStepState
} from '../../../../../shared/planRunTypes'

export type PlanRunViewState = PlanRunState | PlanRunTimelineSnapshot

export type PlanRunPauseCopy = {
  user: string
  interrupted: string
  failed: (step: number) => string
  needsInput: (step: number, inputs: string[]) => string
}

export type PlanStepAction = 'retry' | 'skip' | 'stop'

function planStepSnapshot(
  step: PlanStep,
  state: PlanStepState | undefined
): PlanRunTimelineStepSnapshot {
  const snapshot: PlanRunTimelineStepSnapshot = {
    id: step.id,
    title: step.title,
    access: step.access,
    dependsOn: [...step.dependsOn],
    status: state?.status ?? 'pending',
    attempts: state?.attempts ?? 0,
    missingInputs: [...(state?.report?.missingInputs ?? [])]
  }
  if (step.agent) snapshot.agent = step.agent
  if (state?.agentRunId) snapshot.agentRunId = state.agentRunId
  if (state?.startedAt) snapshot.startedAt = state.startedAt
  if (state?.finishedAt) snapshot.finishedAt = state.finishedAt
  if (state?.report) snapshot.reportStatus = state.report.status
  if (state?.error) snapshot.error = state.error
  return snapshot
}

export function planRunSteps(run: PlanRunViewState): PlanRunTimelineStepSnapshot[] {
  if ('spec' in run) {
    return run.spec.steps.map((step) => planStepSnapshot(step, run.steps[step.id]))
  }
  return run.steps
}

export function planRunGoal(run: PlanRunViewState): string {
  return 'spec' in run ? run.spec.goal : run.goal
}

export function planRunSnapshot(run: PlanRunState): PlanRunTimelineSnapshot {
  return {
    id: run.id,
    status: run.status,
    ...(run.pause ? { pause: run.pause } : {}),
    replans: run.replans,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    goal: run.spec.goal,
    steps: planRunSteps(run)
  }
}

export function planRunProgress(run: PlanRunViewState): { completed: number; total: number } {
  const steps = planRunSteps(run)
  return {
    completed: steps.filter((step) => step.status === 'done').length,
    total: steps.length
  }
}

export function planRunPauseReason(run: PlanRunViewState, copy: PlanRunPauseCopy): string | null {
  const pause = run.pause
  if (!pause) return null
  if (pause.reason === 'user') return copy.user
  if (pause.reason === 'interrupted') return copy.interrupted
  const steps = planRunSteps(run)
  const stepIndex =
    Math.max(
      0,
      steps.findIndex((step) => step.id === pause.stepId)
    ) + 1
  if (pause.reason === 'step_failed') return copy.failed(stepIndex)
  const inputs = steps.find((step) => step.id === pause.stepId)?.missingInputs ?? []
  return copy.needsInput(stepIndex, inputs)
}

export function planStepActions(run: PlanRunViewState, stepId: string): PlanStepAction[] {
  if (
    run.status !== 'paused' ||
    run.pause?.stepId !== stepId ||
    (run.pause.reason !== 'step_failed' && run.pause.reason !== 'needs_input')
  ) {
    return []
  }
  return ['retry', 'skip', 'stop']
}

export function planStepDurationMs(
  step: Pick<PlanRunTimelineStepSnapshot, 'startedAt' | 'finishedAt'>,
  nowMs = Date.now()
): number | null {
  if (!step.startedAt) return null
  const startedAt = Date.parse(step.startedAt)
  const finishedAt = step.finishedAt ? Date.parse(step.finishedAt) : nowMs
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return null
  return Math.max(0, finishedAt - startedAt)
}

export function latestPlanRun(runs: PlanRunTimelineSnapshot[]): PlanRunTimelineSnapshot | null {
  return runs.reduce<PlanRunTimelineSnapshot | null>((latest, run) => {
    if (!latest) return run
    const runTime = Date.parse(run.createdAt)
    const latestTime = Date.parse(latest.createdAt)
    return runTime > latestTime ? run : latest
  }, null)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null
  return value
}

function timelineStepFromUnknown(value: unknown): PlanRunTimelineStepSnapshot | null {
  if (!isRecord(value)) return null
  const dependsOn = stringArray(value.dependsOn)
  const missingInputs = stringArray(value.missingInputs)
  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    (value.access !== 'read' && value.access !== 'write') ||
    typeof value.status !== 'string' ||
    !PLAN_STEP_STATUSES.includes(value.status as (typeof PLAN_STEP_STATUSES)[number]) ||
    typeof value.attempts !== 'number' ||
    !dependsOn ||
    !missingInputs
  ) {
    return null
  }
  return value as unknown as PlanRunTimelineStepSnapshot
}

function pauseFromUnknown(value: unknown): PlanRunPause | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.reason !== 'string') return null
  if (!PLAN_RUN_PAUSE_REASONS.includes(value.reason as PlanRunPause['reason'])) return null
  if (value.stepId !== undefined && typeof value.stepId !== 'string') return null
  return value as unknown as PlanRunPause
}

export function planRunSnapshotFromUnknown(value: unknown): PlanRunTimelineSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.steps)) return null
  const pause = pauseFromUnknown(value.pause)
  const steps = value.steps.map(timelineStepFromUnknown)
  if (
    typeof value.id !== 'string' ||
    typeof value.status !== 'string' ||
    !PLAN_RUN_STATUSES.includes(value.status as (typeof PLAN_RUN_STATUSES)[number]) ||
    typeof value.replans !== 'number' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    typeof value.goal !== 'string' ||
    pause === null ||
    steps.some((step) => step === null)
  ) {
    return null
  }
  return {
    id: value.id,
    status: value.status as PlanRunTimelineSnapshot['status'],
    ...(pause ? { pause } : {}),
    replans: value.replans,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    goal: value.goal,
    steps: steps as PlanRunTimelineStepSnapshot[]
  }
}

export function upsertPlanRun(
  runs: PlanRunTimelineSnapshot[],
  incoming: PlanRunTimelineSnapshot
): PlanRunTimelineSnapshot[] {
  const index = runs.findIndex((run) => run.id === incoming.id)
  if (index < 0) return [...runs, incoming]
  if (Date.parse(runs[index]!.updatedAt) > Date.parse(incoming.updatedAt)) return runs
  const next = [...runs]
  next[index] = incoming
  return next
}
