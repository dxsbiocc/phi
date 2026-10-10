import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import { PHI_REMOTE_READ_DESCRIPTION } from '../remote-workspace-read-tool'
import { PHI_REMOTE_BASH_DESCRIPTION } from '../remote-workspace-bash-tool'
import { PHI_REMOTE_WRITE_DESCRIPTION } from '../remote-workspace-write-tool'
import { PHI_REMOTE_EDIT_DESCRIPTION } from '../remote-workspace-edit-tool'
import {
  PHI_REMOTE_GLOB_DESCRIPTION,
  PHI_REMOTE_GREP_DESCRIPTION
} from '../remote-workspace-search-tools'
import { PHI_REMOTE_DOWNLOAD_DESCRIPTION } from '../download/remote-project-download-tool'
import { PHI_REMOTE_PRESENT_FILES_DESCRIPTION } from '../deliverables/remote-present-tool'
import { PHI_ENV_REQUEST_DESCRIPTION } from '../content/env-request-tool'
import { PHI_SKILL_RUN_DESCRIPTION } from '../content/skill-tools'
import {
  REMOTE_MCP_UNVERIFIED_REASON,
  remoteMcpToolCallReason,
  type RemoteMcpGuardState
} from '../mcp/remote-mcp-policy'

export const REMOTE_TOOLS_PENDING_REASON = '远程项目的该工具暂不可用；该操作没有在本机执行。'

export const REMOTE_WORKSPACE_TOOL_DESCRIPTIONS = [
  ['read', PHI_REMOTE_READ_DESCRIPTION],
  ['bash', PHI_REMOTE_BASH_DESCRIPTION],
  ['glob', PHI_REMOTE_GLOB_DESCRIPTION],
  ['grep', PHI_REMOTE_GREP_DESCRIPTION],
  ['write', PHI_REMOTE_WRITE_DESCRIPTION],
  ['edit', PHI_REMOTE_EDIT_DESCRIPTION]
] as const

export function remoteWorkspaceToolsVerified(
  tools: readonly {
    name: string
    description: string
    sourceInfo: { source: string }
  }[]
): boolean {
  return REMOTE_WORKSPACE_TOOL_DESCRIPTIONS.every(([name, description]) =>
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

const VERIFIED_REMOTE_TOOL_DESCRIPTIONS = new Map([
  ['download_file', PHI_REMOTE_DOWNLOAD_DESCRIPTION],
  ['present_files', PHI_REMOTE_PRESENT_FILES_DESCRIPTION],
  ['skill_run', PHI_SKILL_RUN_DESCRIPTION],
  ['env_request', PHI_ENV_REQUEST_DESCRIPTION]
])

/** Each verified same-name remote backend is released separately. */
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
  dynamicSkillToolRegistered = false
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
  if (dynamicSkillToolRegistered) return undefined
  return { block: true, reason: remoteToolBlockedReason(toolName) }
}

function remoteToolBlockedReason(toolName: string): string {
  const noFallback = '该操作没有在本机执行，也没有回退到本机项目锚点。'
  if (toolName.startsWith('office_')) {
    return `${toolName}：该工具绑定本机 Office 文档与应用进程，远程项目没有对应句柄；请先下载到本机 Office 工作流，或在服务器生成普通文件后用 present_files 交付。${noFallback}`
  }
  if (toolName.startsWith('notebook.')) {
    return `${toolName}：当前 Notebook 后端绑定本机 Jupyter；请改用远程 bash/read/write 处理 .ipynb。${noFallback}`
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
  if (['memory_edit', 'retain', 'recall', 'reflect', 'learn', 'manage_skill'].includes(toolName)) {
    return `${toolName}：该工具会访问本机全局内容存储，尚未声明远程安全边界。${noFallback}`
  }
  return `${toolName}：${REMOTE_TOOLS_PENDING_REASON}`
}

export function createRemoteProjectToolGuardExtension(
  options: {
    dynamicSkillToolNames?: () => ReadonlySet<string>
    remoteMcpToolState?: () => RemoteMcpGuardState | undefined
  } = {}
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const dynamicNames = options.dynamicSkillToolNames?.() ?? new Set<string>()
      const registered = needsRegistration(event.toolName, dynamicNames) ? pi.getAllTools() : []
      if (event.toolName.startsWith('mcp__')) {
        const matches = registered.filter((tool) => tool.name === event.toolName)
        const source = matches.length === 1 ? matches[0]?.sourceInfo.source : undefined
        const reason = remoteMcpToolCallReason(
          event.toolName,
          event.input,
          source,
          options.remoteMcpToolState?.()
        )
        return reason ? { block: true, reason: `${event.toolName}：${reason}` } : undefined
      }
      return remoteProjectToolDecision(
        event.toolName,
        ...workspaceRegistrationFlags(registered),
        verifiedCustomTool(event.toolName, registered),
        verifiedBuiltinTool(event.toolName, registered),
        verifiedRemoteRuntimeTool(event.toolName, registered),
        verifiedDynamicSkillTool(event.toolName, registered, dynamicNames)
      )
    })
  }
}

type ToolInfo = { name: string; description: string; sourceInfo: { source: string } }

function workspaceRegistrationFlags(
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

function needsRegistration(toolName: string, dynamicNames: ReadonlySet<string>): boolean {
  return (
    ['read', 'bash', 'glob', 'grep', 'write', 'edit'].includes(toolName) ||
    SAFE_REMOTE_BUILTINS.has(toolName) ||
    SAFE_PHI_REMOTE_TOOLS.has(toolName) ||
    VERIFIED_REMOTE_TOOL_DESCRIPTIONS.has(toolName) ||
    toolName.startsWith('mcp__') ||
    dynamicNames.has(toolName)
  )
}

function verifiedRemoteRuntimeTool(toolName: string, registered: readonly ToolInfo[]): boolean {
  if (toolName !== 'skill_run' && toolName !== 'env_request') return false
  const description = VERIFIED_REMOTE_TOOL_DESCRIPTIONS.get(toolName)
  return registered.some(
    (tool) =>
      tool.name === toolName &&
      tool.description === description &&
      tool.sourceInfo.source === 'extension'
  )
}

function verifiedDynamicSkillTool(
  toolName: string,
  registered: readonly ToolInfo[],
  dynamicNames: ReadonlySet<string>
): boolean {
  return (
    dynamicNames.has(toolName) &&
    registered.some((tool) => tool.name === toolName && tool.sourceInfo.source === 'extension')
  )
}

function verifiedBuiltinTool(toolName: string, registered: readonly ToolInfo[]): boolean {
  return (
    SAFE_REMOTE_BUILTINS.has(toolName) &&
    registered.some((tool) => tool.name === toolName && tool.sourceInfo.source === 'builtin')
  )
}

function verifiedCustomTool(toolName: string, registered: readonly ToolInfo[]): boolean {
  const expected = VERIFIED_REMOTE_TOOL_DESCRIPTIONS.get(toolName)
  return registered.some(
    (tool) =>
      tool.name === toolName &&
      tool.sourceInfo.source !== 'builtin' &&
      (expected === undefined || tool.description === expected)
  )
}
