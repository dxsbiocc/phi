import type {
  ProjectLocation,
  RemoteProjectConnectionState,
  RemoteProjectReachability
} from '../../../shared/projectLocation'
import type { ProjectRemoteConnection } from '../features/wrapper/lib/remoteConnectionTypes'

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
  createdAt: string
}

export function projectLocationSummary(project: Project): string | null {
  if (project.location?.kind !== 'ssh') return null
  const host = project.remoteHostAlias ?? '服务器档案不可用'
  const phase = project.remoteConnection?.phase ?? project.remoteReachability
  const labels: Record<RemoteProjectReachability, string> = {
    unchecked: '连接待检查',
    connecting: '连接中',
    reachable: '已连接',
    offline: '服务器离线',
    authentication_failed: '认证失败',
    identity_failed: '主机身份校验失败',
    permission_failed: '目录权限不足',
    configuration_failed: '服务器配置不可用'
  }
  const status = phase ? labels[phase] : labels.unchecked
  return `${host} · ${project.location.remoteRoot} · ${status}`
}
