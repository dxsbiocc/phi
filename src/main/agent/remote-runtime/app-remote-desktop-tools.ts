import type { SkippedMcpServerNotice } from '../../../shared/mcpSkippedServers'
import {
  normalizeProjectMemorySettings,
  type ProjectMemorySettings
} from '../../../shared/projectMemoryTypes'
import type { SkillSummary } from '../../../shared/skillTypes'
import type { DesktopMcpAdapter, DesktopMcpOptions } from '../engine/rpc/desktop-mcp-types'
import type {
  DesktopProjectMemoryAdapter,
  DesktopProjectMemoryOptions
} from '../engine/rpc/desktop-project-memory-adapter'
import type {
  DesktopWebSearchAdapter,
  DesktopWebSearchOptions
} from '../engine/rpc/desktop-websearch-types'
import type { PhiHostRequestContext } from '../engine/types'
import type { RemoteProjectSkillCatalog } from '../content/remote-project-skill-service'
import type { RemoteProjectMcpCatalog } from '../mcp/remote-project-mcp-service'
import type {
  AppRemoteDesktopResources,
  AppRemoteSessionRoutingOptions
} from '../remote-session-routing'
import type { McpServerSummary } from '../resources'
import type { RemoteRuntimeDispatchControl } from './controller'

type DesktopIdentity = Parameters<
  NonNullable<AppRemoteSessionRoutingOptions['loadDesktopTools']>
>[0]
type DesktopLoader = NonNullable<AppRemoteSessionRoutingOptions['loadDesktopTools']>

interface DesktopSessionSnapshot {
  cwd: string
  model?: { providerId: string; modelId: string } | null
}

interface DesktopProjectSnapshot {
  memory?: ProjectMemorySettings
}

export interface AppRemoteDesktopToolsDeps {
  agentDir: string
  sessions: {
    findById(sessionId: string): DesktopSessionSnapshot | null | undefined
  }
  projects: {
    getById(projectId: string): DesktopProjectSnapshot | null | undefined
  }
  workspace: {
    resolveBinding(input: { sessionId: string; projectId: string }): { cacheKey: string }
  }
  catalogs: {
    listGlobalSkills(): Promise<SkillSummary[]>
    loadProjectSkills(context: {
      sessionId: string
      projectId: string
      cwd: string
      agentDir: string
    }): Promise<RemoteProjectSkillCatalog>
    listGlobalMcpServers(): Promise<McpServerSummary[]>
    loadProjectMcp(context: {
      sessionId: string
      projectId: string
      cwd: string
      agentDir: string
    }): Promise<RemoteProjectMcpCatalog>
  }
  runtime: {
    scriptTools(identity: {
      runtimeSessionId: string
      remoteSessionId: string
      projectId: string
    }): Promise<{ tools: AppRemoteDesktopResources['tools']['scriptTools'] }>
    approvalFor(
      name: string,
      input: unknown,
      control?: RemoteRuntimeDispatchControl
    ): 'exec' | 'read' | 'write' | undefined
    dispatchControl(
      params: unknown,
      context: PhiHostRequestContext
    ): RemoteRuntimeDispatchControl | undefined
  }
  adapters: {
    createWebSearch(options: DesktopWebSearchOptions): Promise<DesktopWebSearchAdapter>
    createMcp(options: DesktopMcpOptions): Promise<DesktopMcpAdapter>
    createMemory(options: DesktopProjectMemoryOptions): Promise<DesktopProjectMemoryAdapter>
  }
  skippedMcp: {
    notify(sessionId: string, skipped: readonly SkippedMcpServerNotice[]): void
  }
}

interface DesktopBindingGuard {
  memoryPolicy: ProjectMemorySettings
  assertBinding(): void
  assertMemoryBinding(): void
}

function createDesktopBindingGuard(
  identity: DesktopIdentity,
  signal: AbortSignal,
  deps: AppRemoteDesktopToolsDeps
): DesktopBindingGuard {
  const boundary = { sessionId: identity.sessionId, projectId: identity.projectId }
  const selectedBinding = deps.workspace.resolveBinding(boundary).cacheKey
  const memoryPolicy = normalizeProjectMemorySettings(
    deps.projects.getById(identity.projectId)?.memory
  )
  const assertBinding = (): void => {
    signal.throwIfAborted()
    if (
      deps.sessions.findById(identity.sessionId)?.cwd !== identity.resourceCwd ||
      deps.workspace.resolveBinding(boundary).cacheKey !== selectedBinding
    )
      throw new Error('远程资源项目绑定已改变；请显式恢复当前项目会话。')
  }
  const assertMemoryBinding = (): void => {
    assertBinding()
    if (
      JSON.stringify(
        normalizeProjectMemorySettings(deps.projects.getById(identity.projectId)?.memory)
      ) !== JSON.stringify(memoryPolicy)
    )
      throw new Error('项目记忆策略已改变')
  }
  return { memoryPolicy, assertBinding, assertMemoryBinding }
}

function selectDesktopSkills(
  globals: readonly SkillSummary[],
  catalog: RemoteProjectSkillCatalog
): { projectNames: Set<string>; allowedSkills: string[] } {
  const projectNames = new Set(catalog.sources.map((skill) => skill.name))
  // The same skill name can come from several global sources; tool schemas need unique names.
  const allowedSkills = [
    ...new Set([
      ...catalog.sources.map((skill) => skill.name),
      ...globals
        .filter((skill) => skill.enabled && !projectNames.has(skill.name))
        .map((skill) => skill.name)
    ])
  ]
  return { projectNames, allowedSkills }
}

function selectedMcpServerNames(
  globalServers: readonly McpServerSummary[],
  mcpCatalog: RemoteProjectMcpCatalog
): string[] {
  return [
    ...new Set([
      ...globalServers.filter((server) => server.enabled !== false).map((server) => server.name),
      ...mcpCatalog.runtimeServers.map((server) => server.name)
    ])
  ]
}

interface DesktopResourcesInput {
  identity: DesktopIdentity
  signal: AbortSignal
  deps: AppRemoteDesktopToolsDeps
  guards: DesktopBindingGuard
  selected: { projectNames: Set<string>; allowedSkills: string[] }
  catalogs: { globals: readonly SkillSummary[]; project: RemoteProjectSkillCatalog }
  scripts: Awaited<ReturnType<AppRemoteDesktopToolsDeps['runtime']['scriptTools']>>
  search: DesktopWebSearchAdapter
  mcp: DesktopMcpAdapter | undefined
  memory: DesktopProjectMemoryAdapter | undefined
}

function desktopResources(input: DesktopResourcesInput): AppRemoteDesktopResources {
  const { identity, signal, deps, guards, selected, catalogs, scripts, search, mcp, memory } = input
  return {
    tools: {
      assertBinding: guards.assertBinding,
      allowedSkills: selected.allowedSkills,
      skillCatalog: [
        ...catalogs.project.summaries
          .filter((skill) => selected.allowedSkills.includes(skill.name))
          .map((skill) => ({ name: skill.name, description: skill.description })),
        ...catalogs.globals
          .filter((skill) => skill.enabled && !selected.projectNames.has(skill.name))
          .map((skill) => ({ name: skill.name, description: skill.description }))
      ],
      scriptTools: scripts.tools,
      scriptApprovalFor: (name, input, childRunId) => {
        const control = childRunId
          ? deps.runtime.dispatchControl(
              {
                runtimeSessionId: identity.runtimeSessionId,
                remoteSessionId: identity.sessionId,
                projectId: identity.projectId
              },
              { originSessionId: identity.runtimeSessionId, agentRunId: childRunId, signal }
            )
          : undefined
        return deps.runtime.approvalFor(name, input, control)
      },
      remoteLibrary: true,
      desktopWebSearch: search,
      desktopMcp: mcp
    },
    memory,
    close: async () => {
      search.retire()
      mcp?.retire()
      memory?.retire()
      await Promise.allSettled([search.close(), mcp?.close(), memory?.close()])
    }
  }
}

function desktopCatalogContext(
  identity: DesktopIdentity,
  deps: AppRemoteDesktopToolsDeps
): { sessionId: string; projectId: string; cwd: string; agentDir: string } {
  return {
    sessionId: identity.sessionId,
    projectId: identity.projectId,
    cwd: identity.resourceCwd,
    agentDir: deps.agentDir
  }
}

function currentRemoteModel(
  identity: DesktopIdentity,
  guards: DesktopBindingGuard,
  deps: AppRemoteDesktopToolsDeps
): { provider: string; id: string } | undefined {
  guards.assertBinding()
  const model = deps.sessions.findById(identity.sessionId)?.model
  return model ? { provider: model.providerId, id: model.modelId } : undefined
}

async function loadAppRemoteDesktopTools(
  identity: DesktopIdentity,
  signal: AbortSignal,
  deps: AppRemoteDesktopToolsDeps
): ReturnType<DesktopLoader> {
  const guards = createDesktopBindingGuard(identity, signal, deps)
  guards.assertMemoryBinding()
  const context = desktopCatalogContext(identity, deps)
  const [globals, catalog, globalServers, mcpCatalog] = await Promise.all([
    deps.catalogs.listGlobalSkills(),
    deps.catalogs.loadProjectSkills(context),
    deps.catalogs.listGlobalMcpServers(),
    deps.catalogs.loadProjectMcp(context)
  ])
  guards.assertMemoryBinding()
  const selected = selectDesktopSkills(globals, catalog)
  const scripts = await deps.runtime.scriptTools({
    runtimeSessionId: identity.runtimeSessionId,
    remoteSessionId: identity.sessionId,
    projectId: identity.projectId
  })
  guards.assertMemoryBinding()
  const { resourceCwd, ...toolIdentity } = identity
  const search = await deps.adapters.createWebSearch({
    identity: toolIdentity,
    agentDir: deps.agentDir,
    resourceCwd,
    signal,
    currentModel: () => currentRemoteModel(identity, guards, deps)
  })
  let mcp: DesktopMcpAdapter | undefined
  let memory: DesktopProjectMemoryAdapter | undefined
  try {
    if (guards.memoryPolicy.enabled) {
      memory = await deps.adapters.createMemory({
        identity: toolIdentity,
        agentDir: deps.agentDir,
        resourceCwd,
        settings: guards.memoryPolicy,
        signal,
        beforeDispatch: guards.assertMemoryBinding
      })
      guards.assertMemoryBinding()
    }
    const serverNames = selectedMcpServerNames(globalServers, mcpCatalog)
    if (serverNames.length)
      mcp = await deps.adapters.createMcp({
        identity: toolIdentity,
        agentDir: deps.agentDir,
        resourceCwd,
        signal,
        serverNames,
        remoteProjectMcpServers: mcpCatalog.runtimeServers,
        approvalFor: () => 'write',
        beforeDispatch: guards.assertBinding
      })
    guards.assertMemoryBinding()
    deps.skippedMcp.notify(identity.sessionId, mcp?.skipped ?? [])
    return desktopResources({
      identity,
      signal,
      deps,
      guards,
      selected,
      catalogs: { globals, project: catalog },
      scripts,
      search,
      mcp,
      memory
    })
  } catch (error) {
    search.retire(error)
    mcp?.retire(error)
    memory?.retire()
    await Promise.allSettled([search.close(), mcp?.close(), memory?.close()])
    throw error
  }
}

export function createAppRemoteDesktopTools(deps: AppRemoteDesktopToolsDeps): DesktopLoader {
  return (identity, signal) => loadAppRemoteDesktopTools(identity, signal, deps)
}
