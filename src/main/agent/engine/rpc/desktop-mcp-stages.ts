/** Stages of desktop MCP discovery, shared by the worker (which reports) and main (which words it). */
export const DESKTOP_MCP_STAGES = {
  profile: 'checking the MCP server list',
  credentials: 'loading MCP credentials',
  manager: 'preparing the MCP runtime',
  connect: 'connecting MCP servers',
  catalog: 'building the MCP tool list'
} as const
export type DesktopMcpStage = keyof typeof DESKTOP_MCP_STAGES

/** Why one server was left out of a session while the others kept working. */
export type DesktopMcpSkipReason =
  | 'unavailable'
  | 'stdio_not_allowed'
  | 'env_not_ready'
  | 'profile_changed'
  | 'api_key_missing'
  | 'api_key_unavailable'
  | 'prepare_failed'
  | 'connect_failed'
  | 'startup_failed'
  | 'startup_pending'
  | 'not_connected'

const PREFIX = 'MCP discovery stage: '
export class DesktopMcpStageError extends Error {
  constructor(stage: DesktopMcpStage) {
    super(`${PREFIX}${stage}`)
  }
}
/** Stage carried by a worker error, or undefined for anything that is not a known stage code. */
export function desktopMcpStageOf(error: unknown): DesktopMcpStage | undefined {
  const message = error instanceof Error ? error.message : ''
  if (!message.startsWith(PREFIX)) return undefined
  const stage = message.slice(PREFIX.length)
  return Object.hasOwn(DESKTOP_MCP_STAGES, stage) ? (stage as DesktopMcpStage) : undefined
}
