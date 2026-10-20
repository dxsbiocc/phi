import type { PromptAgentSummary } from '../../../shared/promptAgentTypes'
import { loadRemoteAgentCatalog, type RemoteAgentProjectContext } from './remote-agent-service'

interface RemoteAnalysisProject {
  sessionId: string
  project: { id: string }
}

export interface RemoteAgentRequestContextOptions {
  agentDir: string
  bundledDir: string
  getCurrentCwd: () => string
  currentRemoteAnalysisProject: (cwd: string) => RemoteAnalysisProject | null
}

export function remoteAgentProjectContext(
  cwd: string | undefined,
  options: RemoteAgentRequestContextOptions
): RemoteAgentProjectContext {
  const target = cwd ?? options.getCurrentCwd()
  const remote =
    options.currentRemoteAnalysisProject(target) ??
    options.currentRemoteAnalysisProject(options.getCurrentCwd())
  if (!remote) throw new Error('远程项目 agent 请求缺少有效的当前项目会话')
  return {
    sessionId: remote.sessionId,
    projectId: remote.project.id,
    cwd: target,
    agentDir: options.agentDir,
    bundledDir: options.bundledDir
  }
}

export async function listRemotePromptAgents(
  cwd: string | undefined,
  options: RemoteAgentRequestContextOptions
): Promise<PromptAgentSummary[]> {
  return (await loadRemoteAgentCatalog(remoteAgentProjectContext(cwd, options))).entries
}
