import type { RemoteRipgrepCapabilityProfile } from '../../shared/remoteRuntimeRootTypes'
import type {
  RemoteRipgrepProgress,
  RemoteRipgrepResult,
  RemoteRipgrepStatusResult
} from '../../shared/remoteRipgrepTypes'
import { getRemoteHostProfile, remoteConnectionConfigForProfile } from './remote-hosts'
import { getPhiAgentDir } from './runtime-paths'
import { updateLatestCapabilityProfileRipgrepForHost } from './workspace-host/capability-profile-store'
import { ensureRemoteRipgrep, getRemoteRipgrepStatus } from './workspace-host/remote-ripgrep'
import type { ConnectImpl } from './wrappers/executor-remote'
import { connectRemoteSshSession, type RemoteSshSession } from './wrappers/remote-ssh-session'

const REMOTE_OPERATION_TIMEOUT_MS = 6 * 60_000

export interface RemoteRipgrepSettingsRequest {
  action: 'status' | 'install'
  runtimeRoot: string
  confirmedWarnings?: RemoteRipgrepResult['warningCodes']
  forceManaged?: boolean
  signal?: AbortSignal
  onProgress?: (progress: RemoteRipgrepProgress) => void
}

type HostProfile = NonNullable<ReturnType<typeof getRemoteHostProfile>>

export interface RemoteRipgrepSettingsDependencies {
  agentDir?: string
  getHostProfile?: (id: string, agentDir?: string) => HostProfile | undefined
  connect?: ConnectImpl
  status?: typeof getRemoteRipgrepStatus
  ensure?: typeof ensureRemoteRipgrep
  updateLatestProfile?: (
    hostAlias: string,
    status: RemoteRipgrepCapabilityProfile,
    agentDir?: string
  ) => boolean | void
}

function capabilityStatus(
  result: RemoteRipgrepStatusResult | RemoteRipgrepResult
): RemoteRipgrepCapabilityProfile | undefined {
  if (result.status === 'system' && result.version) {
    return { status: 'system', version: result.version }
  }
  if (
    (result.status === 'managed' ||
      result.status === 'installed' ||
      result.status === 'already-installed') &&
    result.version
  ) {
    return { status: 'managed', version: result.version }
  }
  if (result.status === 'not-installed') return { status: 'not-installed' }
  return undefined
}

async function runRequest(
  session: RemoteSshSession,
  request: RemoteRipgrepSettingsRequest,
  dependencies: RemoteRipgrepSettingsDependencies
): Promise<RemoteRipgrepStatusResult | RemoteRipgrepResult> {
  if (request.action === 'status') {
    request.onProgress?.({ stage: 'checking-existing', message: '正在检查远程 ripgrep…' })
    return (dependencies.status ?? getRemoteRipgrepStatus)(session, request.runtimeRoot)
  }
  request.onProgress?.({ stage: 'preparing-directory', message: '正在准备远程 ripgrep…' })
  return (dependencies.ensure ?? ensureRemoteRipgrep)(session, {
    runtimeRoot: request.runtimeRoot,
    confirmedWarnings: request.confirmedWarnings ?? [],
    forceManaged: request.forceManaged,
    signal: request.signal,
    onProgress: request.onProgress
  })
}

export async function runRemoteRipgrepForHost(
  hostProfileId: string,
  request: RemoteRipgrepSettingsRequest,
  dependencies: RemoteRipgrepSettingsDependencies = {}
): Promise<RemoteRipgrepStatusResult | RemoteRipgrepResult> {
  const agentDir = dependencies.agentDir ?? getPhiAgentDir()
  const profile = (dependencies.getHostProfile ?? getRemoteHostProfile)(hostProfileId, agentDir)
  if (!profile) throw new Error('SSH 服务器档案不存在，请重新选择服务器')
  const session = await (dependencies.connect ?? connectRemoteSshSession)({
    ...remoteConnectionConfigForProfile(profile),
    readyTimeoutMs: 15_000,
    execTimeoutMs: REMOTE_OPERATION_TIMEOUT_MS,
    userInitiated: true
  })
  try {
    const result = await runRequest(session, request, dependencies)
    const status = capabilityStatus(result)
    if (status) {
      ;(dependencies.updateLatestProfile ?? updateLatestCapabilityProfileRipgrepForHost)(
        profile.hostAlias,
        status,
        agentDir
      )
    }
    return result
  } finally {
    await session.close()
  }
}
