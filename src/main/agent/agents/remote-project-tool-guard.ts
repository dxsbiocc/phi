import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import { PHI_REMOTE_READ_DESCRIPTION } from '../remote-workspace-read-tool'
import { PHI_REMOTE_BASH_DESCRIPTION } from '../remote-workspace-bash-tool'
import { PHI_REMOTE_WRITE_DESCRIPTION } from '../remote-workspace-write-tool'
import { PHI_REMOTE_EDIT_DESCRIPTION } from '../remote-workspace-edit-tool'
import {
  PHI_REMOTE_GLOB_DESCRIPTION,
  PHI_REMOTE_GREP_DESCRIPTION
} from '../remote-workspace-search-tools'

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

/** Each verified same-name remote backend is released separately. */
export function remoteProjectToolDecision(
  toolName: string,
  remoteReadRegistered = false,
  remoteBashRegistered = false,
  remoteGlobRegistered = false,
  remoteGrepRegistered = false,
  remoteWriteRegistered = false,
  remoteEditRegistered = false,
  safePhiToolRegistered = false
): { block: true; reason: string } | undefined {
  if (toolName === 'read' && remoteReadRegistered) return undefined
  if (toolName === 'bash' && remoteBashRegistered) return undefined
  if (toolName === 'glob' && remoteGlobRegistered) return undefined
  if (toolName === 'grep' && remoteGrepRegistered) return undefined
  if (toolName === 'write' && remoteWriteRegistered) return undefined
  if (toolName === 'edit' && remoteEditRegistered) return undefined
  if (SAFE_PHI_REMOTE_TOOLS.has(toolName) && safePhiToolRegistered) return undefined
  return { block: true, reason: `${toolName}：${REMOTE_TOOLS_PENDING_REASON}` }
}

export function createRemoteProjectToolGuardExtension(): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const registered =
        ['read', 'bash', 'glob', 'grep', 'write', 'edit'].includes(event.toolName) ||
        SAFE_PHI_REMOTE_TOOLS.has(event.toolName)
          ? pi.getAllTools()
          : []
      const remoteReadRegistered = registered.some(
        (tool) =>
          tool.name === 'read' &&
          tool.description === PHI_REMOTE_READ_DESCRIPTION &&
          tool.sourceInfo.source !== 'builtin'
      )
      const remoteBashRegistered = registered.some(
        (tool) =>
          tool.name === 'bash' &&
          tool.description === PHI_REMOTE_BASH_DESCRIPTION &&
          tool.sourceInfo.source !== 'builtin'
      )
      const remoteGlobRegistered = registered.some(
        (tool) =>
          tool.name === 'glob' &&
          tool.description === PHI_REMOTE_GLOB_DESCRIPTION &&
          tool.sourceInfo.source !== 'builtin'
      )
      const remoteGrepRegistered = registered.some(
        (tool) =>
          tool.name === 'grep' &&
          tool.description === PHI_REMOTE_GREP_DESCRIPTION &&
          tool.sourceInfo.source !== 'builtin'
      )
      const remoteWriteRegistered = registered.some(
        (tool) =>
          tool.name === 'write' &&
          tool.description === PHI_REMOTE_WRITE_DESCRIPTION &&
          tool.sourceInfo.source !== 'builtin'
      )
      const remoteEditRegistered = registered.some(
        (tool) =>
          tool.name === 'edit' &&
          tool.description === PHI_REMOTE_EDIT_DESCRIPTION &&
          tool.sourceInfo.source !== 'builtin'
      )
      const safePhiToolRegistered =
        SAFE_PHI_REMOTE_TOOLS.has(event.toolName) &&
        registered.some(
          (tool) => tool.name === event.toolName && tool.sourceInfo.source !== 'builtin'
        )
      return remoteProjectToolDecision(
        event.toolName,
        remoteReadRegistered,
        remoteBashRegistered,
        remoteGlobRegistered,
        remoteGrepRegistered,
        remoteWriteRegistered,
        remoteEditRegistered,
        safePhiToolRegistered
      )
    })
  }
}
