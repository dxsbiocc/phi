import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import type { PhiRemoteMcpGuardState } from '../host'
import { remoteMcpToolCallReason } from '../lib/remote-mcp'
import {
  needsRemoteToolRegistration,
  remoteProjectToolDecision,
  type RemoteProjectToolInfo,
  verifiedBuiltinTool,
  verifiedCustomTool,
  verifiedDynamicAgentTool,
  verifiedDynamicSkillTool,
  verifiedNotebookTool,
  verifiedRemoteRuntimeTool,
  workspaceRegistrationFlags
} from '../lib/remote-project-policy'

export interface RemoteProjectToolGuardOptions {
  dynamicSkillToolNames?: () => ReadonlySet<string>
  dynamicAgentToolNames?: () => ReadonlySet<string>
  dynamicAgentToolDescriptions?: () => ReadonlyMap<string, string>
  remoteMcpToolState?: () => PhiRemoteMcpGuardState | undefined
}

export function createRemoteProjectToolGuardExtension(
  options: RemoteProjectToolGuardOptions = {}
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const dynamicSkillNames = options.dynamicSkillToolNames?.() ?? new Set<string>()
      const dynamicAgentNames = options.dynamicAgentToolNames?.() ?? new Set<string>()
      const dynamicAgentDescriptions = options.dynamicAgentToolDescriptions?.() ?? new Map()
      const registered = needsRemoteToolRegistration(
        event.toolName,
        dynamicSkillNames,
        dynamicAgentNames
      )
        ? (pi.getAllTools() as RemoteProjectToolInfo[])
        : []
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
        verifiedDynamicSkillTool(event.toolName, registered, dynamicSkillNames),
        verifiedNotebookTool(event.toolName, registered),
        verifiedDynamicAgentTool(
          event.toolName,
          registered,
          dynamicAgentNames,
          dynamicAgentDescriptions
        )
      )
    })
  }
}
