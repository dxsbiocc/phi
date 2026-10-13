import { REMOTE_MCP_UNVERIFIED_REASON } from './remote-mcp'
import {
  NOTEBOOK_TOOL_DESCRIPTIONS,
  PHI_ENV_REQUEST_DESCRIPTION,
  PHI_LEARN_DESCRIPTION,
  PHI_REMOTE_BASH_DESCRIPTION,
  PHI_REMOTE_DOWNLOAD_DESCRIPTION,
  PHI_REMOTE_EDIT_DESCRIPTION,
  PHI_REMOTE_GLOB_DESCRIPTION,
  PHI_REMOTE_GREP_DESCRIPTION,
  PHI_REMOTE_PRESENT_FILES_DESCRIPTION,
  PHI_REMOTE_READ_DESCRIPTION,
  PHI_REMOTE_WRITE_DESCRIPTION,
  PHI_SKILL_RUN_DESCRIPTION
} from './remote-tool-descriptions'

export const REMOTE_TOOLS_PENDING_REASON = '远程项目的该工具暂不可用；该操作没有在本机执行。'

export const REMOTE_WORKSPACE_TOOL_DESCRIPTIONS = [
  ['read', PHI_REMOTE_READ_DESCRIPTION],
  ['bash', PHI_REMOTE_BASH_DESCRIPTION],
  ['glob', PHI_REMOTE_GLOB_DESCRIPTION],
  ['grep', PHI_REMOTE_GREP_DESCRIPTION],
  ['write', PHI_REMOTE_WRITE_DESCRIPTION],
  ['edit', PHI_REMOTE_EDIT_DESCRIPTION]
] as const

export type RemoteProjectToolInfo = {
  name: string
  description: string
  sourceInfo: { source: string }
}

type ToolInfo = RemoteProjectToolInfo

export function remoteWorkspaceToolsVerified(
  tools: readonly ToolInfo[],
  requiredNames: readonly string[] = REMOTE_WORKSPACE_TOOL_DESCRIPTIONS.map(([name]) => name)
): boolean {
  const required = new Set(requiredNames)
  return REMOTE_WORKSPACE_TOOL_DESCRIPTIONS.filter(([name]) => required.has(name)).every(
    ([name, description]) =>
      tools.some(
        (tool) =>
          tool.name === name &&
          tool.description === description &&
          tool.sourceInfo.source !== 'builtin'
      )
  )
}

const SAFE_PHI_REMOTE_TOOLS = new Set([
  'Wrapper',
  'browser',
  'ask_user_question',
  'palette_suggest',
  'render_blocks',
  'agent_status',
  'agent_wait',
  'agent_steer',
  'agent_stop',
  'wrapper_search',
  'wrapper_inspect',
  'wrapper_run',
  'wrapper_status',
  'wrapper_wait',
  'wrapper_cancel'
])

const SAFE_REMOTE_BUILTINS = new Set(['web_search'])
const TERMINAL_DRAFT_IPC_NAMES = new Set(['terminal:generateDraft', 'terminal:submitDraft'])
const VERIFIED_REMOTE_TOOL_DESCRIPTIONS = new Map([
  ['download_file', PHI_REMOTE_DOWNLOAD_DESCRIPTION],
  ['present_files', PHI_REMOTE_PRESENT_FILES_DESCRIPTION],
  ['skill_run', PHI_SKILL_RUN_DESCRIPTION],
  ['env_request', PHI_ENV_REQUEST_DESCRIPTION],
  ['learn', PHI_LEARN_DESCRIPTION]
])
const MAIN_SESSION_ONLY_REMOTE_TOOLS = new Set([
  'Wrapper',
  'agent_status',
  'agent_wait',
  'agent_steer',
  'agent_stop'
])
const REMOTE_AGENT_SUPPORTED_TOOL_NAMES = new Set<string>([
  ...REMOTE_WORKSPACE_TOOL_DESCRIPTIONS.map(([name]) => name),
  ...[...SAFE_PHI_REMOTE_TOOLS].filter((name) => !MAIN_SESSION_ONLY_REMOTE_TOOLS.has(name)),
  ...SAFE_REMOTE_BUILTINS,
  ...[...VERIFIED_REMOTE_TOOL_DESCRIPTIONS.keys()].filter((name) => name !== 'learn'),
  ...NOTEBOOK_TOOL_DESCRIPTIONS.keys()
])

export function remoteAgentSupportedToolNames(): ReadonlySet<string> {
  return new Set(REMOTE_AGENT_SUPPORTED_TOOL_NAMES)
}

export function remoteProjectToolDecision(
  toolName: string,
  remoteReadRegistered = false,
  remoteBashRegistered = false,
  remoteGlobRegistered = false,
  remoteGrepRegistered = false,
  remoteWriteRegistered = false,
  remoteEditRegistered = false,
  safePhiToolRegistered = false,
  safeBuiltinRegistered = false,
  verifiedRemoteRuntimeToolRegistered = false,
  dynamicSkillToolRegistered = false,
  verifiedRemoteNotebookToolRegistered = false,
  dynamicAgentToolRegistered = false
): { block: true; reason: string } | undefined {
  if (SAFE_REMOTE_BUILTINS.has(toolName) && safeBuiltinRegistered) return undefined
  if (toolName === 'read' && remoteReadRegistered) return undefined
  if (toolName === 'bash' && remoteBashRegistered) return undefined
  if (toolName === 'glob' && remoteGlobRegistered) return undefined
  if (toolName === 'grep' && remoteGrepRegistered) return undefined
  if (toolName === 'write' && remoteWriteRegistered) return undefined
  if (toolName === 'edit' && remoteEditRegistered) return undefined
  if (
    (SAFE_PHI_REMOTE_TOOLS.has(toolName) ||
      (VERIFIED_REMOTE_TOOL_DESCRIPTIONS.has(toolName) &&
        toolName !== 'skill_run' &&
        toolName !== 'env_request')) &&
    safePhiToolRegistered
  ) {
    return undefined
  }
  if (
    (toolName === 'skill_run' || toolName === 'env_request') &&
    verifiedRemoteRuntimeToolRegistered
  ) {
    return undefined
  }
  if (toolName.startsWith('notebook.')) {
    if (NOTEBOOK_TOOL_DESCRIPTIONS.has(toolName) && verifiedRemoteNotebookToolRegistered) {
      return undefined
    }
    return { block: true, reason: remoteToolBlockedReason(toolName) }
  }
  if (dynamicSkillToolRegistered || dynamicAgentToolRegistered) return undefined
  return { block: true, reason: remoteToolBlockedReason(toolName) }
}

function remoteToolBlockedReason(toolName: string): string {
  const noFallback = '该操作没有在本机执行，也没有回退到本机项目锚点。'
  if (TERMINAL_DRAFT_IPC_NAMES.has(toolName)) {
    return `${toolName}：终端命令草稿是 Phi renderer/main IPC，不是 Agent 工具；已拒绝同名或伪造的工具注册。${noFallback}`
  }
  if (toolName.startsWith('notebook.')) {
    return `${toolName}：当前会话未注册经过验证的远程 Notebook/Jupyter 后端；不会使用本机 Jupyter。${noFallback}`
  }
  if (toolName.startsWith('lib.')) {
    return `${toolName}：当前文献库绑定本机项目文献库；请先在远程项目中使用普通文件记录。${noFallback}`
  }
  if (toolName === 'skill_run' || toolName === 'env_request') {
    return `${toolName}：当前会话没有注册经过验证的服务器运行时后端；请在远程主机设置检查运行时根目录与 micromamba，或重新打开远程会话。${noFallback}`
  }
  if (toolName.startsWith('mcp__')) {
    return `${toolName}：${REMOTE_MCP_UNVERIFIED_REASON}服务器端 stdio WorkspaceHost 暂未支持。${noFallback}`
  }
  if (toolName === 'task') {
    return `${toolName}：SDK task 会继承本机 cwd，尚无安全的远程子会话后端；请使用 Wrapper 与 agent_* 管理工具。${noFallback}`
  }
  if (
    [
      'ast_grep',
      'ast_edit',
      'debug',
      'eval',
      'generate_image',
      'github',
      'lsp',
      'security_scan',
      'tts'
    ].includes(toolName)
  ) {
    return `${toolName}：该 SDK 工具仍绑定本机文件或进程；请使用远程 read/grep/edit/bash 或 browser/web_search。${noFallback}`
  }
  if (toolName === 'learn') {
    return `${toolName}：只有开启项目记忆和“允许 agent 记录经验”后，Phi 自己注册的 learn 工具才可用。${noFallback}`
  }
  if (['memory_edit', 'retain', 'recall', 'reflect', 'manage_skill'].includes(toolName)) {
    return `${toolName}：该工具会访问本机全局内容存储，尚未声明远程安全边界。${noFallback}`
  }
  return `${toolName}：${REMOTE_TOOLS_PENDING_REASON}`
}

export function remoteAgentToolRegistrationVerified(
  toolName: string,
  registered: readonly RemoteProjectToolInfo[]
): boolean {
  const workspaceIndex = REMOTE_WORKSPACE_TOOL_DESCRIPTIONS.findIndex(([name]) => name === toolName)
  if (workspaceIndex >= 0) return workspaceRegistrationFlags(registered)[workspaceIndex] === true
  if (SAFE_REMOTE_BUILTINS.has(toolName)) return verifiedBuiltinTool(toolName, registered)
  if (SAFE_PHI_REMOTE_TOOLS.has(toolName)) return verifiedCustomTool(toolName, registered)
  if (toolName === 'skill_run' || toolName === 'env_request') {
    return verifiedRemoteRuntimeTool(toolName, registered)
  }
  if (NOTEBOOK_TOOL_DESCRIPTIONS.has(toolName)) return verifiedNotebookTool(toolName, registered)
  if (toolName === 'learn') return false
  return VERIFIED_REMOTE_TOOL_DESCRIPTIONS.has(toolName) && verifiedCustomTool(toolName, registered)
}

export function workspaceRegistrationFlags(
  tools: readonly ToolInfo[]
): [boolean, boolean, boolean, boolean, boolean, boolean] {
  return REMOTE_WORKSPACE_TOOL_DESCRIPTIONS.map(([name, description]) =>
    tools.some(
      (tool) =>
        tool.name === name &&
        tool.description === description &&
        tool.sourceInfo.source !== 'builtin'
    )
  ) as [boolean, boolean, boolean, boolean, boolean, boolean]
}

export function needsRemoteToolRegistration(
  toolName: string,
  dynamicSkillNames: ReadonlySet<string>,
  dynamicAgentNames: ReadonlySet<string>
): boolean {
  return (
    ['read', 'bash', 'glob', 'grep', 'write', 'edit'].includes(toolName) ||
    SAFE_REMOTE_BUILTINS.has(toolName) ||
    SAFE_PHI_REMOTE_TOOLS.has(toolName) ||
    VERIFIED_REMOTE_TOOL_DESCRIPTIONS.has(toolName) ||
    NOTEBOOK_TOOL_DESCRIPTIONS.has(toolName) ||
    toolName.startsWith('mcp__') ||
    dynamicSkillNames.has(toolName) ||
    dynamicAgentNames.has(toolName)
  )
}

export function verifiedNotebookTool(toolName: string, registered: readonly ToolInfo[]): boolean {
  const expected = NOTEBOOK_TOOL_DESCRIPTIONS.get(toolName)
  if (!expected) return false
  const matches = registered.filter((tool) => tool.name === toolName)
  return (
    matches.length === 1 &&
    matches[0]?.description === expected &&
    matches[0]?.sourceInfo.source === 'extension'
  )
}

export function verifiedRemoteRuntimeTool(
  toolName: string,
  registered: readonly ToolInfo[]
): boolean {
  if (toolName !== 'skill_run' && toolName !== 'env_request') return false
  const description = VERIFIED_REMOTE_TOOL_DESCRIPTIONS.get(toolName)
  return registered.some(
    (tool) =>
      tool.name === toolName &&
      tool.description === description &&
      tool.sourceInfo.source === 'extension'
  )
}

export function verifiedDynamicSkillTool(
  toolName: string,
  registered: readonly ToolInfo[],
  dynamicNames: ReadonlySet<string>
): boolean {
  return (
    dynamicNames.has(toolName) &&
    registered.some((tool) => tool.name === toolName && tool.sourceInfo.source === 'extension')
  )
}

export function verifiedDynamicAgentTool(
  toolName: string,
  registered: readonly ToolInfo[],
  dynamicNames: ReadonlySet<string>,
  descriptions: ReadonlyMap<string, string>
): boolean {
  if (!dynamicNames.has(toolName)) return false
  const expected = descriptions.get(toolName)
  if (!expected) return false
  const matches = registered.filter((tool) => tool.name === toolName)
  return (
    matches.length === 1 &&
    matches[0]?.sourceInfo.source === 'extension' &&
    matches[0]?.description === expected
  )
}

export function verifiedBuiltinTool(toolName: string, registered: readonly ToolInfo[]): boolean {
  return (
    SAFE_REMOTE_BUILTINS.has(toolName) &&
    registered.some((tool) => tool.name === toolName && tool.sourceInfo.source === 'builtin')
  )
}

export function verifiedCustomTool(toolName: string, registered: readonly ToolInfo[]): boolean {
  const expected = VERIFIED_REMOTE_TOOL_DESCRIPTIONS.get(toolName)
  const matches = registered.filter((tool) => tool.name === toolName)
  return (
    matches.length === 1 &&
    matches[0]?.sourceInfo.source !== 'builtin' &&
    (expected === undefined || matches[0]?.description === expected)
  )
}
