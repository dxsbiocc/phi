import type { AgentExecutionItem } from '../../../lib/agentExecutionTypes'
import {
  workspaceSubagentTabKey,
  type WorkspaceSubagentTab
} from '../../../lib/workspaceResourceTabs'

export function subagentSessionTab(
  item: AgentExecutionItem,
  parent: {
    stateKey: string
    sessionPath: string | null
    cwd: string
    remoteFiles?: WorkspaceSubagentTab['remoteFiles']
  }
): WorkspaceSubagentTab {
  return {
    key: workspaceSubagentTabKey(parent.stateKey, item.id),
    kind: 'subagent',
    itemId: item.id,
    title: item.agentName,
    parentStateKey: parent.stateKey,
    parentSessionPath: parent.sessionPath,
    cwd: parent.cwd,
    remoteFiles: parent.remoteFiles,
    initialItem: item
  }
}
