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
  // K3-2 resource and OMP async shell-job capabilities.
  'resources.reload',
  'shellJobs.list',
  'shellJobs.cancel',
  // K3-2 kernel-owned full-history fork.
  'session.fork',
  'session.abort',
  'session.snapshot',
  'session.close',
  'events.subscribe',
  'approval.respond'
] as const

export type KernelV1Method = (typeof KERNEL_V1_METHODS)[number]

export const KERNEL_EVENT_SESSION_EVENT = 'session.event'
export const KERNEL_EVENT_SESSION_STATE = 'session.state'
export const KERNEL_EVENT_APPROVAL_REQUESTED = 'approval.requested'
export const KERNEL_EVENT_INTERACTION_CANCELLED = 'interaction.cancelled'
export const KERNEL_EVENT_RUN_COMPLETED = 'run.completed'

export const KERNEL_V1_EVENT_TYPES = [
  KERNEL_EVENT_SESSION_EVENT,
  KERNEL_EVENT_SESSION_STATE,
  KERNEL_EVENT_APPROVAL_REQUESTED,
  KERNEL_EVENT_INTERACTION_CANCELLED,
  KERNEL_EVENT_RUN_COMPLETED
] as const

export type KernelV1EventType = (typeof KERNEL_V1_EVENT_TYPES)[number]
