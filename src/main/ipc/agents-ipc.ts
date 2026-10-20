import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { listPromptAgents } from '../agent/resources'
import {
  loadRemoteAgentCatalog,
  revokeRemoteAgent,
  trustRemoteAgent
} from '../agent/agents/remote-agent-service'
import { checkedRemoteAgentTrustMutation } from '../agent/agents/remote-agent-trust-request'
import {
  listRemotePromptAgents,
  remoteAgentProjectContext,
  type RemoteAgentRequestContextOptions
} from '../agent/agents/remote-agent-request-context'

export interface AgentsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  lifecycle: {
    invalidateAgentSession: () => Promise<void>
  }
  workspace: RemoteAgentRequestContextOptions & {
    isRemoteResourceScope: (cwd?: string) => boolean
  }
}

export function registerAgentsIpc(options: AgentsIpcOptions): void {
  const ipcMain = options.ipcMain
  const workspace = options.workspace
  const invalidateAgentSession = options.lifecycle.invalidateAgentSession

  ipcMain.handle(IPC.agents.list, async (_, cwd?: string) =>
    workspace.isRemoteResourceScope(cwd)
      ? listRemotePromptAgents(cwd, workspace)
      : listPromptAgents(cwd ?? workspace.getCurrentCwd())
  )
  ipcMain.handle(IPC.agents.trustRemoteProject, async (_, input: unknown) => {
    const request = checkedRemoteAgentTrustMutation(input)
    const context = remoteAgentProjectContext(request.cwd, workspace)
    await trustRemoteAgent(context, {
      relativePath: request.relativePath,
      contentHash: request.contentHash
    })
    await invalidateAgentSession()
    return (await loadRemoteAgentCatalog(context)).entries
  })
  ipcMain.handle(IPC.agents.revokeRemoteProjectTrust, async (_, input: unknown) => {
    const request = checkedRemoteAgentTrustMutation(input)
    const context = remoteAgentProjectContext(request.cwd, workspace)
    await revokeRemoteAgent(context, {
      relativePath: request.relativePath,
      contentHash: request.contentHash
    })
    await invalidateAgentSession()
    return (await loadRemoteAgentCatalog(context)).entries
  })
}
