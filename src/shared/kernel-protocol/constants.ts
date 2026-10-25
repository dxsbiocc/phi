export const PHI_KERNEL_PROTOCOL_VERSION = { major: 1, minor: 0 } as const

export const MAX_FRAME_BYTES = 1024 * 1024
export const MAX_ERROR_DETAIL_BYTES = 4 * 1024

export const KERNEL_V1_METHODS = [
  'kernel.hello',
  'session.create',
  'session.prompt',
  'session.abort',
  'session.snapshot',
  'session.close',
  'events.subscribe',
  'approval.respond'
] as const

export type KernelV1Method = (typeof KERNEL_V1_METHODS)[number]
