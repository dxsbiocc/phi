import { isRecord } from './guards'

/** The built-in generic agent. Its runs are shown under a name the delegating agent gives each task. */
export const GENERAL_AGENT_NAME = 'General'
export const MIN_GENERAL_DISPLAY_NAME_LENGTH = 2
export const MAX_GENERAL_DISPLAY_NAME_LENGTH = 24

const AGENT_TOOL_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/

/** Agent delegation tools are named after their agent: capitalised, e.g. `Wrapper`. */
export function isAgentToolName(toolName: unknown): toolName is string {
  return typeof toolName === 'string' && AGENT_TOOL_NAME_PATTERN.test(toolName)
}

/** The trimmed per-task name of a General run, or undefined when it is missing or invalid. */
export function generalAgentDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || /[\r\n]/u.test(raw)) return undefined
  const name = raw.trim()
  return name.length >= MIN_GENERAL_DISPLAY_NAME_LENGTH &&
    name.length <= MAX_GENERAL_DISPLAY_NAME_LENGTH
    ? name
    : undefined
}

/**
 * The name a delegation call is shown under: the per-task name for General, the agent's own
 * name for a specialist, undefined when the tool is not an agent.
 */
export function agentDisplayNameFromCall(toolName: unknown, args: unknown): string | undefined {
  if (!isAgentToolName(toolName)) return undefined
  if (toolName !== GENERAL_AGENT_NAME || !isRecord(args)) return toolName
  return generalAgentDisplayName(args.name) ?? toolName
}
