import type { PhiAgentDefinition } from './definition'
import {
  remoteAgentToolRegistrationVerified,
  type RemoteProjectToolInfo
} from './remote-project-tool-guard'

export interface RemoteAgentToolResolution {
  agent: PhiAgentDefinition
  available: boolean
  diagnostics: string[]
  unavailableReason?: string
}

type RemoteAgentToolAvailability = readonly RemoteProjectToolInfo[] | ReadonlySet<string>

const SPECIALIST_SCOPED_TOOLS = new Set(['skill_run', 'env_request'])

function toolIsAvailable(
  agent: PhiAgentDefinition,
  name: string,
  available: RemoteAgentToolAvailability
): boolean {
  if (name.startsWith('wrapper_') && agent.name !== 'Wrapper') return false
  if (name === 'skill_run' && agent.skills.length === 0) return false
  if (name === 'env_request' && !agent.environment) return false
  if (!Array.isArray(available)) return (available as ReadonlySet<string>).has(name)
  return remoteAgentToolRegistrationVerified(name, available)
}

export function resolveRemoteAgentTools(
  agent: PhiAgentDefinition,
  available: RemoteAgentToolAvailability
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

export function shouldAttachRemoteParentTool(
  agent: PhiAgentDefinition,
  toolName: string,
  hasSpecialistTool: boolean
): boolean {
  return (
    agent.tools.includes(toolName) && !hasSpecialistTool && !SPECIALIST_SCOPED_TOOLS.has(toolName)
  )
}
