export const PHI_KERNEL_PROTOCOL_VERSION = { major: 1, minor: 0 } as const

export const MAX_FRAME_BYTES = 1024 * 1024
export const MAX_ERROR_DETAIL_BYTES = 4 * 1024
export const MAX_CLIENT_RUN_KEY_LENGTH = 256

export const KERNEL_V1_METHODS = [
  'kernel.hello',
  'session.create',
  'session.open',
  'session.adopt',
  'sessions.list',
  'session.prompt',
  // K3-1 kernel-owned planning and specialist-run control.
  'session.plan.enter',
  'session.plan.cancel',
  'planRuns.list',
  'planRuns.get',
  'planRuns.retryStep',
  'planRuns.skipStep',
  'planRuns.replan',
  'planRuns.stop',
  'agentRuns.start',
  'agentRuns.list',
  'agentRuns.wait',
  'agentRuns.steer',
  'agentRuns.stop',
  // K3-2 resource and OMP async shell-job capabilities.
  'resources.reload',
  'shellJobs.list',
  'shellJobs.cancel',
  // K3-2 kernel-owned full-history fork.
  'session.fork',
  'session.abort',
  'session.snapshot',
  'session.setModel',
  'session.setThinkingLevel',
  'session.contextUsage',
  'session.compact',
  'session.getAutoCompaction',
  'session.setAutoCompaction',
  'session.close',
  'models.catalog',
  'modelAccess.configure',
  'events.subscribe',
  'approval.respond'
] as const

export type KernelV1Method = (typeof KERNEL_V1_METHODS)[number]

export const KERNEL_EVENT_SESSION_EVENT = 'session.event'
export const KERNEL_EVENT_SESSION_STATE = 'session.state'
export const KERNEL_EVENT_APPROVAL_REQUESTED = 'approval.requested'
export const KERNEL_EVENT_INTERACTION_CANCELLED = 'interaction.cancelled'
export const KERNEL_EVENT_RUN_COMPLETED = 'run.completed'
export const KERNEL_EVENT_MODELS_CHANGED = 'models.changed'
export const KERNEL_EVENT_PLAN_RUN_UPDATED = 'planRun.updated'
export const KERNEL_EVENT_AGENT_RUN_STARTED = 'agentRun.started'
export const KERNEL_EVENT_AGENT_RUN_STEP = 'agentRun.step'
export const KERNEL_EVENT_AGENT_RUN_FINISHED = 'agentRun.finished'
export const KERNEL_EVENT_AGENT_RUN_REPORTED = 'agentRun.reported'

export const KERNEL_V1_EVENT_TYPES = [
  KERNEL_EVENT_SESSION_EVENT,
  KERNEL_EVENT_SESSION_STATE,
  KERNEL_EVENT_APPROVAL_REQUESTED,
  KERNEL_EVENT_INTERACTION_CANCELLED,
  KERNEL_EVENT_RUN_COMPLETED,
  KERNEL_EVENT_MODELS_CHANGED,
  KERNEL_EVENT_PLAN_RUN_UPDATED,
  KERNEL_EVENT_AGENT_RUN_STARTED,
  KERNEL_EVENT_AGENT_RUN_STEP,
  KERNEL_EVENT_AGENT_RUN_FINISHED,
  KERNEL_EVENT_AGENT_RUN_REPORTED
] as const

export type KernelV1EventType = (typeof KERNEL_V1_EVENT_TYPES)[number]
