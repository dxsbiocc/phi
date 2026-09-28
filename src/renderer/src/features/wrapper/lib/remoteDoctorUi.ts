import type {
  RemoteDoctorOptions,
  RemoteDoctorReport
} from '../../../../../shared/remoteDoctorTypes'
import type { ProjectRemoteConnection } from './remoteConnectionTypes'

export interface RemoteDoctorTarget {
  identity: string
  revision: string
  hostProfileId: string
  remotePath?: string
  options?: RemoteDoctorOptions
}

export type RemoteDoctorUiState =
  | { phase: 'idle' }
  | { phase: 'running'; key: string }
  | { phase: 'done'; key: string; report: RemoteDoctorReport }
  | { phase: 'failed'; key: string; message: string }

export type RemoteDoctorRequest = (
  hostProfileId: string,
  remotePath?: string,
  options?: RemoteDoctorOptions
) => Promise<RemoteDoctorReport>

export function remoteHostDoctorTarget(hostId: string, hostAlias: string): RemoteDoctorTarget {
  return {
    identity: `host:${hostId}`,
    revision: hostAlias,
    hostProfileId: hostId,
    options: { scope: 'connection' }
  }
}

export function remoteConnectionDoctorTarget(
  projectId: string,
  connection: ProjectRemoteConnection,
  hostAlias: string,
  remotePath: string
): RemoteDoctorTarget {
  return {
    identity: `connection:${projectId}:${connection.id}`,
    revision: hostAlias,
    hostProfileId: connection.hostProfileId,
    remotePath: remotePath.trim(),
    options: {
      scheduler: connection.hpc?.scheduler,
      controller: connection.hpc?.controller,
      runtime: connection.hpc?.runtime,
      nextflowBin: connection.hpc?.nextflowBin
    }
  }
}

export function remoteDoctorTargetKey(target: RemoteDoctorTarget): string {
  return JSON.stringify([
    target.identity,
    target.revision,
    target.hostProfileId,
    target.remotePath ?? null,
    target.options ?? null
  ])
}

export function remoteHostIdFromDoctorKey(key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(key)
    const identity = Array.isArray(parsed) ? parsed[0] : undefined
    return typeof identity === 'string' && identity.startsWith('host:')
      ? identity.slice('host:'.length)
      : null
  } catch {
    return null
  }
}

export function withHostDoctorState(
  previous: Record<string, RemoteDoctorUiState>,
  state: RemoteDoctorUiState
): Record<string, RemoteDoctorUiState> {
  if (state.phase === 'idle') return previous
  const hostId = remoteHostIdFromDoctorKey(state.key)
  return hostId ? { ...previous, [hostId]: state } : previous
}

export type RemoteHostCheckTone = 'idle' | 'running' | 'success' | 'warning' | 'error'

export function remoteHostCheckPresentation(
  state: RemoteDoctorUiState | undefined,
  targetKey: string
): { tone: RemoteHostCheckTone; message: string } {
  if (!state || state.phase === 'idle' || state.key !== targetKey) {
    return { tone: 'idle', message: '测试连接' }
  }
  if (state.phase === 'running') return { tone: 'running', message: '正在测试连接…' }
  if (state.phase === 'failed') return { tone: 'error', message: state.message }
  const ssh = state.report.checks.find((check) => check.id === 'ssh')
  if (ssh?.status === 'ok') {
    return { tone: 'success', message: 'SSH 连接成功。点击可重新测试。' }
  }
  const issues = state.report.checks.filter((check) => check.id === 'ssh' && check.status !== 'ok')
  const errors = issues.filter((check) => check.status === 'error')
  const details = issues
    .slice(0, 4)
    .map((check) => `${check.message}${check.suggestion ? ` — ${check.suggestion}` : ''}`)
    .join('\n')
    .slice(0, 600)
  if (!ssh || errors.length > 0) {
    return { tone: 'error', message: details || '连接检查未通过；请检查服务器设置。' }
  }
  return { tone: 'warning', message: details || ssh.message }
}

class UiTimeoutError extends Error {}

async function withDeadline<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new UiTimeoutError()), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** One check per controller; stale replies cannot replace a newer target. */
export function createRemoteDoctorUiController(
  request: RemoteDoctorRequest,
  onChange: (state: RemoteDoctorUiState) => void,
  timeoutMs = 90_000
): {
  check(target: RemoteDoctorTarget): Promise<void>
  invalidate(): void
  dispose(): void
  getState(): RemoteDoctorUiState
} {
  let state: RemoteDoctorUiState = { phase: 'idle' }
  let sequence = 0
  let active: Promise<void> | null = null
  const publish = (next: RemoteDoctorUiState): void => {
    state = next
    onChange(next)
  }

  return {
    check(target) {
      if (active) return active
      const key = remoteDoctorTargetKey(target)
      const requestId = ++sequence
      publish({ phase: 'running', key })
      const task = (async () => {
        try {
          const result = await withDeadline(
            Promise.resolve().then(() =>
              request(target.hostProfileId, target.remotePath, target.options)
            ),
            timeoutMs
          )
          if (sequence === requestId) publish({ phase: 'done', key, report: result })
        } catch (error) {
          if (sequence === requestId) {
            publish({
              phase: 'failed',
              key,
              message:
                error instanceof UiTimeoutError
                  ? '测试超时，请检查网络和服务器状态后重试。'
                  : '测试未完成，请检查连接后重试。'
            })
          }
        } finally {
          if (sequence === requestId) active = null
        }
      })()
      active = task
      return task
    },
    invalidate() {
      sequence += 1
      active = null
      if (state.phase !== 'idle') publish({ phase: 'idle' })
    },
    dispose() {
      sequence += 1
      active = null
      state = { phase: 'idle' }
    },
    getState: () => state
  }
}

/** Host rows can check independently while duplicate clicks on one host share the same request. */
export function createRemoteHostDoctorUiController(
  request: RemoteDoctorRequest,
  onChange: (hostId: string, state: RemoteDoctorUiState) => void,
  timeoutMs = 90_000
): {
  check(target: RemoteDoctorTarget): Promise<void>
  invalidate(hostId?: string): void
  dispose(): void
  getState(hostId: string): RemoteDoctorUiState
} {
  const controllers = new Map<
    string,
    { key: string; controller: ReturnType<typeof createRemoteDoctorUiController> }
  >()

  function invalidateHost(hostId: string): void {
    const current = controllers.get(hostId)
    if (!current) return
    current.controller.invalidate()
    controllers.delete(hostId)
  }

  return {
    check(target) {
      const key = remoteDoctorTargetKey(target)
      const hostId = remoteHostIdFromDoctorKey(key)
      if (!hostId) throw new Error('服务器连接测试需要 SSH 主机目标')
      const current = controllers.get(hostId)
      if (current?.key === key) return current.controller.check(target)
      if (current) invalidateHost(hostId)
      const controller = createRemoteDoctorUiController(
        request,
        (state) => onChange(hostId, state),
        timeoutMs
      )
      controllers.set(hostId, { key, controller })
      return controller.check(target)
    },
    invalidate(hostId) {
      if (hostId) invalidateHost(hostId)
      else for (const id of [...controllers.keys()]) invalidateHost(id)
    },
    dispose() {
      for (const { controller } of controllers.values()) controller.dispose()
      controllers.clear()
    },
    getState: (hostId) => controllers.get(hostId)?.controller.getState() ?? { phase: 'idle' }
  }
}
