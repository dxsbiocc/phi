import type { SkippedMcpServerNotice } from '../../../shared/mcpSkippedServers'
import type { DesktopMcpAdapter, DesktopMcpOptions } from '../engine/rpc/desktop-mcp-types'
import type { RemoteProjectMcpCatalog } from '../mcp/remote-project-mcp-service'
import type { AppRemoteSessionRoutingOptions } from '../remote-session-routing'
import type { McpServerSummary } from '../resources'

type DesktopIdentity = Parameters<
  NonNullable<AppRemoteSessionRoutingOptions['loadDesktopTools']>
>[0]
type DesktopLoader = NonNullable<AppRemoteSessionRoutingOptions['loadDesktopTools']>

export interface AppRemoteDesktopToolsDeps {
  agentDir: string
  sessions: {
    findById(sessionId: string): { cwd: string } | null | undefined
  }
  workspace: {
    resolveBinding(input: { sessionId: string; projectId: string }): { cacheKey: string }
  }
  catalogs: {
    listGlobalMcpServers(): Promise<McpServerSummary[]>
    loadProjectMcp(context: {
      sessionId: string
      projectId: string
      cwd: string
      agentDir: string
    }): Promise<RemoteProjectMcpCatalog>
  }
  adapters: {
    createMcp(options: DesktopMcpOptions): Promise<DesktopMcpAdapter>
  }
  skippedMcp: {
    notify(sessionId: string, skipped: readonly SkippedMcpServerNotice[]): void
  }
}

function selectedMcpServerNames(
  globalServers: readonly McpServerSummary[],
  project: RemoteProjectMcpCatalog,
  excluded: readonly string[] = []
): string[] {
  const blocked = new Set(excluded)
  return [
    ...new Set([
      ...globalServers.filter((server) => server.enabled !== false).map((server) => server.name),
      ...project.runtimeServers.map((server) => server.name)
    ])
  ].filter((name) => !blocked.has(name))
}

function bindingGuard(
  identity: DesktopIdentity,
  signal: AbortSignal,
  deps: AppRemoteDesktopToolsDeps
): () => void {
  const boundary = { sessionId: identity.sessionId, projectId: identity.projectId }
  const selectedBinding = deps.workspace.resolveBinding(boundary).cacheKey
  return () => {
    signal.throwIfAborted()
    if (
      deps.sessions.findById(identity.sessionId)?.cwd !== identity.resourceCwd ||
      deps.workspace.resolveBinding(boundary).cacheKey !== selectedBinding
    )
      throw new Error('远程资源项目绑定已改变；请显式恢复当前项目会话。')
  }
}

async function loadDesktopMcp(
  identity: DesktopIdentity,
  signal: AbortSignal,
  deps: AppRemoteDesktopToolsDeps
): ReturnType<DesktopLoader> {
  const assertBinding = bindingGuard(identity, signal, deps)
  assertBinding()
  const context = {
    sessionId: identity.sessionId,
    projectId: identity.projectId,
    cwd: identity.resourceCwd,
    agentDir: deps.agentDir
  }
  const [globalServers, project] = await Promise.all([
    deps.catalogs.listGlobalMcpServers(),
    deps.catalogs.loadProjectMcp(context)
  ])
  assertBinding()
  const serverNames = selectedMcpServerNames(
    globalServers,
    project,
    identity.excludedMcpServerNames
  )
  if (!serverNames.length) {
    deps.skippedMcp.notify(identity.sessionId, [])
    return {}
  }
  const desktopMcp = await deps.adapters.createMcp({
    identity: {
      runtimeSessionId: identity.runtimeSessionId,
      sessionId: identity.sessionId,
      projectId: identity.projectId,
      cwd: identity.cwd
    },
    agentDir: deps.agentDir,
    resourceCwd: identity.resourceCwd,
    signal,
    serverNames,
    remoteProjectMcpServers: project.runtimeServers,
    approvalFor: () => 'write',
    beforeDispatch: assertBinding
  })
  try {
    assertBinding()
    deps.skippedMcp.notify(identity.sessionId, desktopMcp.skipped)
    return {
      desktopMcp,
      close: async () => {
        desktopMcp.retire()
        await desktopMcp.close()
      }
    }
  } catch (error) {
    desktopMcp.retire(error)
    await desktopMcp.close().catch(() => undefined)
    throw error
  }
}

export function createAppRemoteDesktopTools(deps: AppRemoteDesktopToolsDeps): DesktopLoader {
  return (identity, signal) => loadDesktopMcp(identity, signal, deps)
}
