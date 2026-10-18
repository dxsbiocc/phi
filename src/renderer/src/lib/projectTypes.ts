import { windowUiCopy } from './windowUiCopy'
import type {
  ProjectLocation,
  RemoteProjectConnectionState,
  RemoteProjectReachability
} from '../../../shared/projectLocation'
import type { ProjectRemoteConnection } from '../features/wrapper/lib/remoteConnectionTypes'
import type { ProjectMemorySettings } from '../../../shared/projectMemoryTypes'

/** App-wide project view; location determines whether its path is local or on SSH. */
export interface Project {
  id: string
  name: string
  location: ProjectLocation
  workingDirectory: string
  permissionMode: 'auto' | 'ask' | 'full'
  pathAvailable?: boolean
  remoteReachability?: RemoteProjectReachability
  remoteConnection?: RemoteProjectConnectionState
  remoteHostAlias?: string
  gitStatus?: { branch: string; dirty: boolean }
  defaultModel?: { providerId: string; modelId: string }
  defaultThinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  remoteConnections?: ProjectRemoteConnection[]
  defaultRemoteConnectionId?: string
  remoteWorkspaceRoot?: string
  memory?: ProjectMemorySettings
  createdAt: string
}

export function projectLocationSummary(project: Project): string | null {
  if (project.location?.kind !== 'ssh') return null
  const host = project.remoteHostAlias ?? windowUiCopy.unavailableServer
  const phase = project.remoteConnection?.phase ?? project.remoteReachability
  const labels = windowUiCopy.connection
  const status = phase ? labels[phase] : labels.unchecked
  return `${host} · ${project.location.remoteRoot} · ${status}`
}
