import { resolve } from 'node:path'

import type { SessionKeyRegistry } from '../../app-state/session-key-registry'
import { readHostRemoteEnvironmentPaths } from '../remote-environment-store'
import { remoteMicromambaManifestVersion } from '../remote-micromamba-artifact'
import { remoteProjectAnchorPath } from '../remote-project-anchor'
import { getProject, type Project } from '../projects'
import { resolveRemoteBaseEnvironment } from '../remote-runtime/base-environment'
import type { RemoteRuntimeRootResolution } from '../remote-runtime-root'
import { openRemoteRuntimeWorkspace, type RemoteRuntimeTarget } from '../remote-runtime/workspace'
import {
  resolveAuthorizedRemoteConnectionConfig,
  resolveRemoteWorkspaceHostBinding
} from '../remote-workspace-boundary'
import { findPhiSessionById, type PhiSessionManifest } from '../session/session-store'
import type { AnalysisNotebookExecutor } from './analysis-jupyter-execution'
import type { NotebookDraftChange } from './notebook-tool-executor'
import {
  createRemoteAnalysisNotebookBackend,
  type RemoteAnalysisNotebookBackend
} from './remote-analysis-notebook-backend'
import { createRemoteNotebookBackendDisposal } from './remote-notebook-backend-disposal'
import type { RemoteJupyterStartJobs } from './remote-jupyter-start-jobs'

export interface RemoteNotebookRuntimeServices {
  createRemoteAnalysisNotebookBackend: typeof createRemoteAnalysisNotebookBackend
  findPhiSessionById: (sessionId: string) => PhiSessionManifest | null
  getProject: typeof getProject
  openRemoteRuntimeWorkspace: typeof openRemoteRuntimeWorkspace
  readHostRemoteEnvironmentPaths: typeof readHostRemoteEnvironmentPaths
  remoteMicromambaManifestVersion: typeof remoteMicromambaManifestVersion
  remoteProjectAnchorPath: typeof remoteProjectAnchorPath
  resolveAuthorizedRemoteConnectionConfig: typeof resolveAuthorizedRemoteConnectionConfig
  resolveRemoteBaseEnvironment: typeof resolveRemoteBaseEnvironment
  resolveRemoteWorkspaceHostBinding: typeof resolveRemoteWorkspaceHostBinding
}

const defaultServices: RemoteNotebookRuntimeServices = {
  createRemoteAnalysisNotebookBackend,
  findPhiSessionById,
  getProject,
  openRemoteRuntimeWorkspace,
  readHostRemoteEnvironmentPaths,
  remoteMicromambaManifestVersion,
  remoteProjectAnchorPath,
  resolveAuthorizedRemoteConnectionConfig,
  resolveRemoteBaseEnvironment,
  resolveRemoteWorkspaceHostBinding
}

export interface RemoteNotebookRuntimeDeps {
  agentDir: string
  projectRemoteRuntimeRoot: (project: Project) => RemoteRuntimeRootResolution
  sessionKeys: Pick<SessionKeyRegistry, 'originFor' | 'phiSessionIdFor'>
  notebookExecutor: AnalysisNotebookExecutor
  startJobs: RemoteJupyterStartJobs
  onDraftChanged: (change: NotebookDraftChange) => void
  services?: RemoteNotebookRuntimeServices
}

export interface RemoteNotebookRuntime {
  remoteNotebookSessionIds: Map<string, string>
  activeRemoteNotebookBackends: () => RemoteAnalysisNotebookBackend[]
  remoteNotebookBackend: (project: Project, sessionId: string) => RemoteAnalysisNotebookBackend
  resolveRemoteNotebookToolBackend: (identity: {
    runtimeSessionId: string
    sessionId: string
    projectId: string
  }) => Promise<{
    projectCwd: string
    execute: RemoteAnalysisNotebookBackend['tools']['execute']
  } | null>
  disposeRemoteNotebookBackend: (projectId: string) => Promise<void>
  disposeRemoteNotebookBackends: () => Promise<void>
}

interface RemoteNotebookRuntimeState {
  deps: RemoteNotebookRuntimeDeps
  services: RemoteNotebookRuntimeServices
  remoteNotebookBackends: Map<string, RemoteAnalysisNotebookBackend>
  remoteNotebookSessionIds: Map<string, string>
}

function remoteNotebookTarget(
  state: RemoteNotebookRuntimeState,
  project: Project,
  sessionId: string
): RemoteRuntimeTarget {
  if (project.location.kind !== 'ssh') throw new Error('远程 Notebook 项目位置无效')
  const root = state.deps.projectRemoteRuntimeRoot(project)
  const micromambaPath = state.services.readHostRemoteEnvironmentPaths(
    project.location.hostProfileId,
    state.deps.agentDir
  ).micromamba
  return {
    runtimeSessionId: `notebook:${project.id}`,
    sessionId,
    projectId: project.id,
    configuredRoot: root.configured,
    ...(micromambaPath ? { micromambaPath } : {})
  }
}

function createRemoteNotebookBackend(
  state: RemoteNotebookRuntimeState,
  project: Project,
  sessionId: string
): RemoteAnalysisNotebookBackend {
  const target = remoteNotebookTarget(state, project, sessionId)
  const binding = state.services.resolveRemoteWorkspaceHostBinding({
    sessionId,
    projectId: project.id
  })
  const authorized = state.services.resolveAuthorizedRemoteConnectionConfig({
    sessionId,
    projectId: project.id
  })
  return state.services.createRemoteAnalysisNotebookBackend({
    projectCwd: binding.canonicalRoot,
    projectName: project.name,
    serverLabel: authorized.hostAlias,
    runtimeSessionId: target.runtimeSessionId,
    micromambaVersion: state.services.remoteMicromambaManifestVersion(),
    projectHostConfig: binding.config,
    openWorkspace: (runtimeSessionId, signal) => {
      if (runtimeSessionId !== target.runtimeSessionId) {
        throw new Error('远程 Notebook runtime 身份无效；没有回退到本机执行。')
      }
      const activeSessionId = state.remoteNotebookSessionIds.get(project.id)
      if (!activeSessionId) {
        throw new Error('远程 Notebook 会话已释放；没有回退到本机执行。')
      }
      return state.services.openRemoteRuntimeWorkspace(
        remoteNotebookTarget(state, project, activeSessionId),
        signal
      )
    },
    connection: authorized.connection,
    projectId: project.id,
    startJobs: state.deps.startJobs,
    // Read at each start, so a path saved in remote settings applies without reopening.
    configuredJupyterPath: () =>
      project.location.kind === 'ssh'
        ? state.services.readHostRemoteEnvironmentPaths(
            project.location.hostProfileId,
            state.deps.agentDir
          ).jupyter
        : undefined,
    confirmEnvironment: async () => true,
    resolveBaseEnvironment: (ref, pluginId) =>
      state.services.resolveRemoteBaseEnvironment(ref, pluginId, state.deps.agentDir),
    notebookExecutor: state.deps.notebookExecutor,
    onDraftChanged: state.deps.onDraftChanged
  })
}

function remoteNotebookBackend(
  state: RemoteNotebookRuntimeState,
  project: Project,
  sessionId: string
): RemoteAnalysisNotebookBackend {
  state.remoteNotebookSessionIds.set(project.id, sessionId)
  const existing = state.remoteNotebookBackends.get(project.id)
  if (existing) return existing
  const backend = createRemoteNotebookBackend(state, project, sessionId)
  state.remoteNotebookBackends.set(project.id, backend)
  return backend
}

async function resolveRemoteNotebookToolBackend(
  state: RemoteNotebookRuntimeState,
  remoteBackendFor: RemoteNotebookRuntime['remoteNotebookBackend'],
  identity: { runtimeSessionId: string; sessionId: string; projectId: string }
): Promise<{
  projectCwd: string
  execute: RemoteAnalysisNotebookBackend['tools']['execute']
} | null> {
  const manifest = state.services.findPhiSessionById(identity.sessionId)
  const project = state.services.getProject(identity.projectId)
  const origin = state.deps.sessionKeys.originFor(identity.runtimeSessionId)
  if (
    !manifest ||
    !project ||
    !origin ||
    project.location.kind !== 'ssh' ||
    manifest.projectId !== project.id ||
    state.deps.sessionKeys.phiSessionIdFor(origin.sessionKey) !== manifest.sessionId ||
    resolve(origin.cwd) !== resolve(manifest.cwd) ||
    resolve(manifest.cwd) !==
      resolve(state.services.remoteProjectAnchorPath(project.id, state.deps.agentDir))
  ) {
    return null
  }
  const backend = remoteBackendFor(project, manifest.sessionId)
  return {
    projectCwd: backend.projectCwd,
    execute: (request, control) => backend.tools.execute(request, control)
  }
}

async function disposeRemoteNotebookBackends(state: RemoteNotebookRuntimeState): Promise<void> {
  const backends = [...state.remoteNotebookBackends.values()]
  state.remoteNotebookBackends.clear()
  state.remoteNotebookSessionIds.clear()
  await Promise.all(backends.map((backend) => backend.dispose()))
}

export function createRemoteNotebookRuntime(
  deps: RemoteNotebookRuntimeDeps
): RemoteNotebookRuntime {
  const state: RemoteNotebookRuntimeState = {
    deps,
    services: deps.services ?? defaultServices,
    remoteNotebookBackends: new Map(),
    remoteNotebookSessionIds: new Map()
  }
  const { disposeRemoteNotebookBackend } = createRemoteNotebookBackendDisposal({
    remoteNotebookBackends: state.remoteNotebookBackends,
    remoteNotebookSessionIds: state.remoteNotebookSessionIds
  })
  const backendFor: RemoteNotebookRuntime['remoteNotebookBackend'] = (project, sessionId) =>
    remoteNotebookBackend(state, project, sessionId)

  return {
    remoteNotebookSessionIds: state.remoteNotebookSessionIds,
    activeRemoteNotebookBackends: () => [...state.remoteNotebookBackends.values()],
    remoteNotebookBackend: backendFor,
    resolveRemoteNotebookToolBackend: (identity) =>
      resolveRemoteNotebookToolBackend(state, backendFor, identity),
    disposeRemoteNotebookBackend,
    disposeRemoteNotebookBackends: () => disposeRemoteNotebookBackends(state)
  }
}
