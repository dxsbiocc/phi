import type { PhiAgentDefinition } from './definition'
import { NOTEBOOK_TOOL_NAMES } from '../notebook/notebook-tools'

const MAIN_SESSION_ONLY_TOOLS = new Set([
  'Wrapper',
  'capability_search',
  'capability_install',
  'find_skills',
  'agent_status',
  'agent_wait',
  'agent_steer',
  'agent_stop',
  'learn'
])

const RPC_REMOTE_AGENT_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'glob',
  'grep',
  'browser',
  'ask_user_question',
  'palette_suggest',
  'render_blocks',
  'wrapper_search',
  'wrapper_inspect',
  'wrapper_run',
  'wrapper_status',
  'wrapper_wait',
  'wrapper_cancel',
  'web_search',
  'download_file',
  'present_files',
  'skill_run',
  'env_request',
  ...NOTEBOOK_TOOL_NAMES
])

export function remoteAgentSupportedToolNames(): ReadonlySet<string> {
  return new Set([...RPC_REMOTE_AGENT_TOOLS].filter((name) => !MAIN_SESSION_ONLY_TOOLS.has(name)))
}

export interface RemoteAgentToolResolution {
  agent: PhiAgentDefinition
  available: boolean
  diagnostics: string[]
  unavailableReason?: string
}

function toolIsAvailable(
  agent: PhiAgentDefinition,
  name: string,
  available: ReadonlySet<string>
): boolean {
  if (name.startsWith('wrapper_') && agent.name !== 'Wrapper') return false
  if (name === 'skill_run' && agent.skills.length === 0) return false
  if (name === 'env_request' && !agent.environment) return false
  return available.has(name)
}

export function resolveRemoteAgentTools(
  agent: PhiAgentDefinition,
  available: ReadonlySet<string>
): RemoteAgentToolResolution {
  const tools = agent.tools.filter((name) => toolIsAvailable(agent, name, available))
  const diagnostics = agent.tools
    .filter((name) => !tools.includes(name))
    .map((name) => `该 agent 在远程项目中缺少：${name}`)
  const unavailableReason =
    tools.length === 0
      ? '该 agent 在远程项目中不可用：没有可用工具'
      : !tools.includes('read') && !tools.includes('bash')
        ? '该 agent 在远程项目中不可用：至少需要 read 或 bash'
        : undefined
  return {
    agent: { ...agent, tools },
    available: unavailableReason === undefined,
    diagnostics,
    ...(unavailableReason ? { unavailableReason } : {})
  }
}
