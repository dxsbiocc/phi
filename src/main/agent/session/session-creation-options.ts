import type { ProjectLocation } from '../../../shared/projectLocation'
import type { CreateAgentSessionOptions, RuntimeSessionManager } from '../runtime/runtime-adapter'

export interface RemoteSessionProject {
  projectId: string
  location: Extract<ProjectLocation, { kind: 'ssh' }>
}

export type SessionCreationOptions = CreateAgentSessionOptions & {
  remoteRuntimeRoot?: unknown
}

export interface SessionCreationOptionsInput {
  remoteRecovery: CreateAgentSessionOptions['remoteRecovery']
  modelRuntime: CreateAgentSessionOptions['modelRuntime']
  model: CreateAgentSessionOptions['model']
  thinkingLevel: CreateAgentSessionOptions['thinkingLevel']
  autoCompaction: CreateAgentSessionOptions['autoCompaction']
  cwd: string
  sessionManager: RuntimeSessionManager
  resourceLoader: CreateAgentSessionOptions['resourceLoader']
  phiAgents: CreateAgentSessionOptions['phiAgents']
  remoteProjectMcpServers: CreateAgentSessionOptions['remoteProjectMcpServers']
  projectBound: boolean
  workMode: NonNullable<CreateAgentSessionOptions['workMode']>
  memory: CreateAgentSessionOptions['memory']
  remoteRuntimeRoot?: unknown
  remoteProject: RemoteSessionProject | null
  phiSessionId: string
  remoteContextFiles: Array<{ path: string; content: string }>
  personaMarkdown: string
}

export function buildSessionCreationOptions(
  input: SessionCreationOptionsInput
): SessionCreationOptions {
  const options: SessionCreationOptions = {}
  if (input.remoteRecovery) options.remoteRecovery = input.remoteRecovery
  options.modelRuntime = input.modelRuntime
  options.thinkingLevel = input.thinkingLevel
  if (input.autoCompaction) options.autoCompaction = input.autoCompaction
  options.cwd = input.cwd
  options.sessionManager = input.sessionManager
  if (input.resourceLoader) options.resourceLoader = input.resourceLoader
  if (input.phiAgents?.length) options.phiAgents = input.phiAgents
  if (input.remoteProjectMcpServers?.length) {
    options.remoteProjectMcpServers = input.remoteProjectMcpServers
  }
  options.projectBound = input.projectBound
  options.workMode = input.workMode
  if (input.memory?.enabled) options.memory = input.memory
  if (input.remoteProject) {
    if (input.remoteRuntimeRoot) options.remoteRuntimeRoot = input.remoteRuntimeRoot
    options.remoteProject = {
      ...input.remoteProject,
      phiSessionId: input.phiSessionId,
      contextFiles: input.remoteContextFiles
    }
  }
  options.personaMarkdown = input.personaMarkdown
  if (input.model) options.model = input.model
  return options
}
