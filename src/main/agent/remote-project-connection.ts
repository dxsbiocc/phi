import type { RemoteProjectConnectionState } from '../../shared/projectLocation'
import { getProject, setRemoteProjectConnectionState, type Project } from './projects'
import { resolveRemoteWorkspacePath } from './remote-workspace-boundary'
import { findPhiSessionById, type PhiSessionManifest } from './session/session-store'
import { RemoteSshConnectionError, sshConnectionDiagnosis } from './wrappers/remote-ssh-diagnostics'

function connectionState(
  phase: RemoteProjectConnectionState['phase'],
  message?: string,
  suggestion?: string
): RemoteProjectConnectionState {
  return {
    phase,
    ...(message ? { message } : {}),
    ...(suggestion ? { suggestion } : {}),
    checkedAt: new Date().toISOString()
  }
}

/** Only transport/root failures change the shared connection state; a missing file does not. */
export function classifyRemoteProjectConnectionError(
  error: unknown
): RemoteProjectConnectionState | null {
  if (error instanceof RemoteSshConnectionError) {
    const diagnosis = sshConnectionDiagnosis(error.code)
    const phase =
      error.code === 'host_key_changed' ||
      error.code === 'host_key_unknown' ||
      error.code === 'host_key_unverified'
        ? 'identity_failed'
        : error.code === 'authentication_failed'
          ? 'authentication_failed'
          : error.code === 'configuration_invalid' || error.code === 'ssh_missing'
            ? 'configuration_failed'
            : 'offline'
    return connectionState(phase, diagnosis.message, diagnosis.suggestion)
  }
  const message = error instanceof Error ? error.message : ''
  if (/SSH.*(?:连接已关闭|命令超时|超时)/i.test(message) && !/调用已取消/.test(message)) {
    return connectionState(
      'offline',
      'SSH 连接中断或超时',
      '检查网络和服务器后重试读取；写入或命令结果未知时先到服务器核对。'
    )
  }
  if (/远程路径授权失败：项目根目录已变化或不可访问/.test(message)) {
    return connectionState(
      'permission_failed',
      '远程项目目录已变化或不可访问',
      '检查服务器上的项目目录和访问权限。'
    )
  }
  return null
}

export interface RemoteProjectConnectionDependencies {
  getProject?: (id: string) => Project | undefined
  getManifest?: (id: string) => PhiSessionManifest | null
  setState?: (id: string, state: RemoteProjectConnectionState) => void
  resolvePath?: typeof resolveRemoteWorkspacePath
}

export class RemoteProjectConnectionTracker {
  private readonly revisions = new Map<string, number>()

  constructor(private readonly dependencies: RemoteProjectConnectionDependencies = {}) {}

  private nextRevision(projectId: string): number {
    const revision = (this.revisions.get(projectId) ?? 0) + 1
    this.revisions.set(projectId, revision)
    return revision
  }

  private validProject(projectId: string): boolean {
    return (this.dependencies.getProject ?? getProject)(projectId)?.location.kind === 'ssh'
  }

  private set(projectId: string, state: RemoteProjectConnectionState, revision: number): void {
    if (!this.validProject(projectId) || this.revisions.get(projectId) !== revision) return
    const setState = this.dependencies.setState ?? setRemoteProjectConnectionState
    setState(projectId, state)
  }

  async check(sessionId: string, projectId: string): Promise<RemoteProjectConnectionState> {
    const manifest = (this.dependencies.getManifest ?? findPhiSessionById)(sessionId)
    const project = (this.dependencies.getProject ?? getProject)(projectId)
    if (
      !manifest ||
      !project ||
      project.location.kind !== 'ssh' ||
      manifest.projectId !== projectId ||
      manifest.projectLocation?.kind !== 'ssh'
    ) {
      throw new Error('远程项目会话归属无效')
    }
    const revision = this.nextRevision(projectId)
    this.set(projectId, connectionState('connecting', '正在连接服务器'), revision)
    try {
      await (this.dependencies.resolvePath ?? resolveRemoteWorkspacePath)({
        sessionId,
        projectId,
        path: '.',
        mode: 'existing'
      })
      const ready = connectionState('reachable')
      this.set(projectId, ready, revision)
      return ready
    } catch (error) {
      const failed =
        classifyRemoteProjectConnectionError(error) ??
        connectionState(
          'permission_failed',
          '远程项目目录不可访问',
          '检查目录权限和保存的项目路径后重试。'
        )
      this.set(projectId, failed, revision)
      return failed
    }
  }

  async observe<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const revision = this.validProject(projectId) ? this.nextRevision(projectId) : 0
    try {
      const result = await operation()
      if (
        result &&
        typeof result === 'object' &&
        'status' in result &&
        result.status === 'unknown'
      ) {
        const reason = 'reason' in result ? result.reason : undefined
        if (reason !== 'cancelled') {
          this.set(
            projectId,
            connectionState(
              'offline',
              'SSH 回执中断，操作结果未知',
              '先到服务器核对结果；不要自动重发写入或提交命令。'
            ),
            revision
          )
        }
      } else {
        this.set(projectId, connectionState('reachable'), revision)
      }
      return result
    } catch (error) {
      const failed = classifyRemoteProjectConnectionError(error)
      if (failed) this.set(projectId, failed, revision)
      throw error
    }
  }

  noteRemoteRunLost(projectId: string): void {
    const revision = this.validProject(projectId) ? this.nextRevision(projectId) : 0
    this.set(
      projectId,
      connectionState(
        'offline',
        '远程作业状态暂时无法确认',
        '恢复连接后重新查看作业状态；不要重复提交。'
      ),
      revision
    )
  }
}
