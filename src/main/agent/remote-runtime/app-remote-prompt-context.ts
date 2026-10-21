import { join } from 'node:path'

import type { resolveRemoteRuntimePromptContext } from '../remote-runtime-context'
import type { loadRemoteProjectInstructions } from '../remote-project-instructions'
import type { readRuntimeRecoverySummarySeed } from '../session/recovery-summary'
import type { StoredSessionEvent } from '../session/session-store'
import type { AppRemoteSessionRoutingOptions } from '../remote-session-routing'
import type { Project } from '../projects'

type PromptContextLoader = NonNullable<AppRemoteSessionRoutingOptions['loadPromptContext']>
type PromptContextIdentity = Parameters<PromptContextLoader>[0]

export interface AppRemotePromptContextDeps {
  agentDir: string
  sessions: {
    findById(sessionId: string): { cwd: string } | null | undefined
    readEvents(sessionId: string): StoredSessionEvent[]
  }
  projects: {
    require(projectId: string): Project
    runtimeRoot(project: Project): { source: string; configured: string }
  }
  workspace: {
    resolveBinding(input: { sessionId: string; projectId: string }): {
      cacheKey: string
      canonicalRoot: string
    }
  }
  context: {
    loadProjectInstructions: typeof loadRemoteProjectInstructions
    getPersonaMarkdown(): string
    resolveRuntimePrompt: typeof resolveRemoteRuntimePromptContext
    readRecoverySummary: typeof readRuntimeRecoverySummarySeed
  }
}

async function loadAppRemotePromptContext(
  identity: PromptContextIdentity,
  signal: AbortSignal,
  deps: AppRemotePromptContextDeps
): ReturnType<PromptContextLoader> {
  const boundary = { sessionId: identity.sessionId, projectId: identity.projectId }
  const selected = deps.workspace.resolveBinding(boundary)
  const project = deps.projects.require(identity.projectId)
  if (project.location.kind !== 'ssh') throw new Error('远程主会话配置缺少 SSH 项目')
  const assertBinding = (): void => {
    signal.throwIfAborted()
    if (
      deps.sessions.findById(identity.sessionId)?.cwd !== identity.resourceCwd ||
      selected.canonicalRoot !== identity.cwd ||
      deps.workspace.resolveBinding(boundary).cacheKey !== selected.cacheKey
    ) {
      throw new Error('远程主会话配置的项目或主机绑定已改变')
    }
  }
  assertBinding()
  const contextFiles = await deps.context.loadProjectInstructions(project.location)
  assertBinding()
  const personaMarkdown = deps.context.getPersonaMarkdown()
  const runtimeRoot = deps.projects.runtimeRoot(project)
  const runtime = deps.context.resolveRuntimePrompt(
    {
      hostProfileId: project.location.hostProfileId,
      canonicalRoot: project.location.canonicalRoot,
      ...(runtimeRoot.source === 'project' ? { projectOverride: runtimeRoot.configured } : {})
    },
    deps.agentDir
  )
  assertBinding()
  const recoverySummary = deps.context.readRecoverySummary({
    sessionId: identity.sessionId,
    projectId: identity.projectId,
    events: deps.sessions.readEvents(identity.sessionId)
  })?.content
  assertBinding()
  return {
    personaMarkdown,
    ...(personaMarkdown ? { personaPath: join(deps.agentDir, 'AGENTS.md') } : {}),
    contextFiles,
    runtime,
    ...(recoverySummary ? { recoverySummary } : {})
  }
}

export function createAppRemotePromptContext(
  deps: AppRemotePromptContextDeps
): PromptContextLoader {
  return (identity, signal) => loadAppRemotePromptContext(identity, signal, deps)
}
