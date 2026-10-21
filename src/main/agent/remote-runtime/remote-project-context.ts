import type { SessionState } from '../../app-state/session-state'
import type { SessionResolution } from '../../session-runtime/session-resolution'
import { isRemoteProjectAnchorPath } from '../remote-project-anchor'
import type { RemoteProjectSkillContext } from '../content/remote-project-skill-service'
import { getProject, type Project } from '../projects'

export interface RemoteProjectContextServices {
  getProject: typeof getProject
  isRemoteProjectAnchorPath: typeof isRemoteProjectAnchorPath
}

const defaultServices: RemoteProjectContextServices = {
  getProject,
  isRemoteProjectAnchorPath
}

export interface RemoteProjectContextDeps {
  sessionState: Pick<SessionState, 'sessionKey' | 'sessionPath' | 'cwd'>
  sessionResolution: Pick<SessionResolution, 'findPhiManifestForSession'>
  agentDir: string
  services?: RemoteProjectContextServices
}

export interface RemoteProjectContext {
  currentRemoteAnalysisProject: (
    targetCwd: string
  ) => { project: Project; sessionId: string } | null
  isRemoteResourceScope: (cwd?: string) => boolean
  remoteSkillProjectContext: (cwd?: string) => RemoteProjectSkillContext
}

export function createRemoteProjectContext(deps: RemoteProjectContextDeps): RemoteProjectContext {
  const services = deps.services ?? defaultServices

  const currentRemoteAnalysisProject: RemoteProjectContext['currentRemoteAnalysisProject'] = (
    targetCwd
  ) => {
    const manifest = deps.sessionResolution.findPhiManifestForSession(
      deps.sessionState.sessionKey,
      deps.sessionState.sessionPath,
      deps.sessionState.cwd
    )
    const project = manifest?.projectId ? services.getProject(manifest.projectId) : undefined
    if (!manifest || !project || project.location.kind !== 'ssh') return null
    const accepted = new Set([
      manifest.cwd,
      project.workingDirectory,
      project.location.remoteRoot,
      project.location.canonicalRoot
    ])
    return accepted.has(targetCwd) ? { project, sessionId: manifest.sessionId } : null
  }

  const isRemoteResourceScope: RemoteProjectContext['isRemoteResourceScope'] = (cwd) => {
    return (
      services.isRemoteProjectAnchorPath(deps.sessionState.cwd, deps.agentDir) ||
      (typeof cwd === 'string' && services.isRemoteProjectAnchorPath(cwd, deps.agentDir))
    )
  }

  const remoteSkillProjectContext: RemoteProjectContext['remoteSkillProjectContext'] = (cwd) => {
    const target = cwd ?? deps.sessionState.cwd
    const remote =
      currentRemoteAnalysisProject(target) ?? currentRemoteAnalysisProject(deps.sessionState.cwd)
    if (!remote) throw new Error('远程项目 Skill 请求缺少有效的当前项目会话')
    return {
      sessionId: remote.sessionId,
      projectId: remote.project.id,
      cwd: target,
      agentDir: deps.agentDir
    }
  }

  return {
    currentRemoteAnalysisProject,
    isRemoteResourceScope,
    remoteSkillProjectContext
  }
}
