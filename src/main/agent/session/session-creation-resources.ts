import { existsSync } from 'node:fs'

import {
  discoverPhiAgents,
  type PhiAgentDiagnostic,
  type PhiAgentDiscoveryResult
} from '../agents/discovery'
import { buildAgentLeaderPrompt } from '../agents/leader-prompt'
import { loadRemoteAgentCatalog } from '../agents/remote-agent-service'
import {
  loadRemoteProjectSkillCatalog,
  type RemoteProjectSkillCatalog
} from '../content/remote-project-skill-service'
import {
  loadRemoteProjectMcpCatalog,
  type RemoteProjectMcpCatalog
} from '../mcp/remote-project-mcp-service'
import {
  createRuntimeResourceLoader,
  getCoreAuthoringSkillDir,
  type InlineExtension,
  type RuntimeResourceLoader,
  type Skill as RuntimeSkill
} from '../runtime/runtime-adapter'

export interface SessionCreationPromptResources {
  appendSystemPrompt: string[]
  shouldLoadCoreSkill: boolean
}

export interface SessionCreationResourceLookup {
  sessionId: string
  projectId: string
  cwd: string
  agentDir: string
}

export function createSessionCreationResourceLookup(
  sessionId: string | undefined,
  projectId: string | undefined,
  cwd: string,
  agentDir: string
): SessionCreationResourceLookup {
  return {
    sessionId: sessionId ?? '',
    projectId: projectId ?? '',
    cwd,
    agentDir
  }
}

export function emptySessionCreationAgentScan(): PhiAgentDiscoveryResult {
  return { agents: [], diagnostics: [] }
}

export function sessionCreationAgentDiagnosticLog(diagnostic: PhiAgentDiagnostic): {
  event: 'agent_definition_warning' | 'agent_definition_invalid'
  metadata: { filePath: string; message: string }
} {
  return {
    event: diagnostic.level === 'warning' ? 'agent_definition_warning' : 'agent_definition_invalid',
    metadata: { filePath: diagnostic.filePath, message: diagnostic.message }
  }
}

export function loadRemoteSessionCreationAgents(
  context: SessionCreationResourceLookup,
  bundledDir: () => string
): ReturnType<typeof loadRemoteAgentCatalog> {
  return loadRemoteAgentCatalog({ ...context, bundledDir: bundledDir() })
}

export function discoverLocalSessionCreationAgents(
  context: SessionCreationResourceLookup,
  bundledDir: () => string
): PhiAgentDiscoveryResult {
  return discoverPhiAgents({
    cwd: context.cwd,
    agentDir: context.agentDir,
    bundledDir: bundledDir()
  })
}

export function loadRemoteSessionCreationSkills(
  context: SessionCreationResourceLookup
): ReturnType<typeof loadRemoteProjectSkillCatalog> {
  return loadRemoteProjectSkillCatalog({
    sessionId: context.sessionId,
    projectId: context.projectId,
    cwd: context.cwd,
    agentDir: context.agentDir
  })
}

export function loadRemoteSessionCreationMcp(
  context: SessionCreationResourceLookup
): ReturnType<typeof loadRemoteProjectMcpCatalog> {
  return loadRemoteProjectMcpCatalog({
    sessionId: context.sessionId,
    projectId: context.projectId,
    cwd: context.cwd,
    agentDir: context.agentDir
  })
}

export interface SessionCreationPromptResourceInput {
  notebookPrompt: string | null
  agentScan: PhiAgentDiscoveryResult
  remoteProject: boolean
  onDiagnostic: (diagnostic: PhiAgentDiscoveryResult['diagnostics'][number]) => void
}

export function buildSessionCreationPromptResources(
  input: SessionCreationPromptResourceInput
): SessionCreationPromptResources {
  for (const diagnostic of input.agentScan.diagnostics) {
    input.onDiagnostic(diagnostic)
  }
  const agentLeaderPrompt = buildAgentLeaderPrompt(input.agentScan.agents)
  const appendSystemPrompt = [
    ...(input.notebookPrompt ? [input.notebookPrompt] : []),
    ...(agentLeaderPrompt ? [agentLeaderPrompt] : [])
  ]
  return {
    appendSystemPrompt,
    shouldLoadCoreSkill: !input.remoteProject && existsSync(getCoreAuthoringSkillDir())
  }
}

export interface SessionCreationResourceLoaderInput extends SessionCreationPromptResources {
  useRpc: boolean
  remoteProject: boolean
  cwd: string
  agentDir: string
  remoteProjectSkills: RuntimeSkill[]
  extensionFactories: InlineExtension[]
}

export function createSessionCreationResourceLoader(
  input: SessionCreationResourceLoaderInput
): RuntimeResourceLoader | undefined {
  if (
    input.useRpc ||
    (!input.remoteProject &&
      !input.shouldLoadCoreSkill &&
      input.appendSystemPrompt.length === 0 &&
      input.extensionFactories.length === 0)
  ) {
    return undefined
  }
  return createRuntimeResourceLoader({
    cwd: input.remoteProject ? input.agentDir : input.cwd,
    agentDir: input.agentDir,
    ...(input.remoteProject
      ? {
          noExtensions: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          remoteProjectSkills: input.remoteProjectSkills
        }
      : {}),
    ...(input.appendSystemPrompt.length > 0
      ? { appendSystemPrompt: input.appendSystemPrompt }
      : {}),
    ...(input.extensionFactories.length > 0 ? { extensionFactories: input.extensionFactories } : {})
  })
}

export interface SessionCreationResources {
  remoteContextFiles: Array<{ path: string; content: string }> | null
  agentScan: PhiAgentDiscoveryResult
  remoteMcpCatalog: RemoteProjectMcpCatalog | undefined
  resourceLoader: RuntimeResourceLoader | undefined
  personaMarkdown: string
}

export interface SessionCreationResourceAssemblyInput {
  useRpc: boolean
  remoteProject: boolean
  cwd: string
  agentDir: string
  notebookPrompt: string | null
  agentScan: PhiAgentDiscoveryResult
  remoteSkillCatalog: RemoteProjectSkillCatalog | undefined
  remoteMcpCatalog: RemoteProjectMcpCatalog | undefined
  remoteContextFiles: SessionCreationResources['remoteContextFiles']
  personaMarkdown: string
  extensionFactories(): InlineExtension[]
  onDiagnostic(diagnostic: PhiAgentDiagnostic): void
  remoteProjectSkills(catalog: RemoteProjectSkillCatalog): RuntimeSkill[]
}

export function assembleSessionCreationResources(
  input: SessionCreationResourceAssemblyInput
): SessionCreationResources {
  const promptResources = buildSessionCreationPromptResources({
    notebookPrompt: input.notebookPrompt,
    agentScan: input.agentScan,
    remoteProject: input.remoteProject,
    onDiagnostic: input.onDiagnostic
  })
  const extensionFactories = input.extensionFactories()
  const remoteProjectSkills = input.remoteSkillCatalog
    ? input.remoteProjectSkills(input.remoteSkillCatalog)
    : []
  const resourceLoader = createSessionCreationResourceLoader({
    ...promptResources,
    useRpc: input.useRpc,
    remoteProject: input.remoteProject,
    cwd: input.cwd,
    agentDir: input.agentDir,
    remoteProjectSkills,
    extensionFactories
  })
  return {
    remoteContextFiles: input.remoteContextFiles,
    agentScan: input.agentScan,
    remoteMcpCatalog: input.remoteMcpCatalog,
    resourceLoader,
    personaMarkdown: input.personaMarkdown
  }
}
