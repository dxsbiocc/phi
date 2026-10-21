import { basename, resolve } from 'node:path'

import { isPathInsideRoot } from '../local-file-access'
import {
  assertProjectPathAvailable,
  getProjectByCwd,
  listProjects,
  type Project
} from '../projects'
import { isRemoteProjectAnchorPath } from '../remote-project-anchor'
import type { AnalysisWorkspaceContext } from './analysis-notebook-operations'

export interface AnalysisWorkspaceResolutionServices {
  assertProjectPathAvailable: typeof assertProjectPathAvailable
  getProjectByCwd: typeof getProjectByCwd
  listProjects: typeof listProjects
  isRemoteProjectAnchorPath: typeof isRemoteProjectAnchorPath
  isPathInsideRoot: typeof isPathInsideRoot
}

const defaultServices: AnalysisWorkspaceResolutionServices = {
  assertProjectPathAvailable,
  getProjectByCwd,
  listProjects,
  isRemoteProjectAnchorPath,
  isPathInsideRoot
}

interface RemoteAnalysisProject {
  project: Project
  sessionId: string
}

export interface AnalysisWorkspaceResolutionDeps {
  agentDir: string
  getCurrentSessionCwd: () => string
  currentRemoteAnalysisProject: (targetCwd: string) => RemoteAnalysisProject | null
  getNoProjectTaskFolder: () => string
  realDirectoryPath: (
    path: string,
    options?: { create?: boolean; fallbackToResolved?: boolean }
  ) => string | null
  services?: AnalysisWorkspaceResolutionServices
}

export interface AnalysisWorkspaceResolution {
  resolveAnalysisWorkspaceByCwd: (cwd?: string) => AnalysisWorkspaceContext | null
  isRemoteAnalysisCwd: (cwd: string) => boolean
}

export function createAnalysisWorkspaceResolution(
  deps: AnalysisWorkspaceResolutionDeps
): AnalysisWorkspaceResolution {
  const services = deps.services ?? defaultServices

  function resolveAnalysisWorkspaceByCwd(cwd?: string): AnalysisWorkspaceContext | null {
    const targetCwd = cwd ?? deps.getCurrentSessionCwd()
    const remote = deps.currentRemoteAnalysisProject(targetCwd)
    if (remote && remote.project.location.kind === 'ssh') {
      return {
        workingDirectory: remote.project.location.canonicalRoot,
        name: remote.project.name,
        project: remote.project,
        remoteSessionId: remote.sessionId
      }
    }
    if (services.isRemoteProjectAnchorPath(targetCwd, deps.agentDir)) return null
    const project = services.getProjectByCwd(targetCwd)
    if (project) {
      services.assertProjectPathAvailable(project.workingDirectory)
      return {
        workingDirectory: project.workingDirectory,
        name: project.name,
        project
      }
    }

    const noProjectTaskFolder = deps.getNoProjectTaskFolder()
    const noProjectWorkspaceRealPath = deps.realDirectoryPath(noProjectTaskFolder, {
      create: true,
      fallbackToResolved: true
    })
    const targetRealPath = deps.realDirectoryPath(targetCwd, {
      create: resolve(targetCwd) === resolve(noProjectTaskFolder),
      fallbackToResolved: resolve(targetCwd) === resolve(noProjectTaskFolder)
    })
    if (!targetRealPath) return null

    const currentCwdRealPath = services.getProjectByCwd(deps.getCurrentSessionCwd())
      ? null
      : deps.realDirectoryPath(deps.getCurrentSessionCwd())
    if (targetRealPath !== noProjectWorkspaceRealPath && targetRealPath !== currentCwdRealPath) {
      return null
    }

    return {
      workingDirectory: targetRealPath,
      name: basename(targetRealPath) || 'workspace',
      project: null
    }
  }

  function isRemoteAnalysisCwd(cwd: string): boolean {
    if (services.isRemoteProjectAnchorPath(cwd, deps.agentDir)) return true
    if (deps.currentRemoteAnalysisProject(cwd)) return true
    const localProject = services.getProjectByCwd(cwd)
    if (localProject && localProject.location?.kind !== 'ssh') return false
    return services.listProjects().some((project) => {
      if (project.location.kind !== 'ssh') return false
      return [project.workingDirectory, project.location.remoteRoot, project.location.canonicalRoot]
        .filter((root): root is string => typeof root === 'string' && root.length > 0)
        .some((root) => services.isPathInsideRoot(root, cwd))
    })
  }

  return { resolveAnalysisWorkspaceByCwd, isRemoteAnalysisCwd }
}
