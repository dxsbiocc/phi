import { readHostRuntimeRoot } from '../remote-runtime-root-store'
import type { RemoteRuntimeRootResolution } from '../remote-runtime-root'
import type { Project } from '../projects'
import { resolveProjectRuntimeRoot } from './project-runtime-root'

export interface ProjectRuntimeRootServices {
  readHostRuntimeRoot: typeof readHostRuntimeRoot
  resolveProjectRuntimeRoot: typeof resolveProjectRuntimeRoot
}

const defaultServices: ProjectRuntimeRootServices = {
  readHostRuntimeRoot,
  resolveProjectRuntimeRoot
}

export interface ProjectRuntimeRootContextDeps {
  agentDir: string
  services?: ProjectRuntimeRootServices
}

export interface ProjectRuntimeRootContext {
  projectRemoteRuntimeRoot: (project: Project) => RemoteRuntimeRootResolution
}

export function createProjectRuntimeRootContext(
  deps: ProjectRuntimeRootContextDeps
): ProjectRuntimeRootContext {
  const services = deps.services ?? defaultServices

  const projectRemoteRuntimeRoot: ProjectRuntimeRootContext['projectRemoteRuntimeRoot'] = (
    project
  ) => {
    const hostOverride =
      project.location.kind === 'ssh'
        ? services.readHostRuntimeRoot(project.location.hostProfileId, deps.agentDir)
        : undefined
    return services.resolveProjectRuntimeRoot(project, hostOverride)
  }

  return { projectRemoteRuntimeRoot }
}
