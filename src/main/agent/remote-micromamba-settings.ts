import type {
  RemoteMicromambaCapabilityProfile,
  RemoteMicromambaDownloadCapability,
  RemoteRuntimeRootWarningCode
} from '../../shared/remoteRuntimeRootTypes'
import {
  normalizeRemoteMicromambaMirrorPrefix,
  type RemoteMicromambaArtifact,
  type RemoteMicromambaPlatform,
  type RemoteMicromambaResult
} from '../../shared/remoteMicromambaTypes'
import { getRemoteHostProfile, remoteConnectionConfigForProfile } from './remote-hosts'
import {
  describeRemoteMicromambaArtifact,
  getRemoteMicromambaArtifact,
  remoteMicromambaSourceUrls,
  type RemoteMicromambaArtifactPlan
} from './remote-micromamba-artifact'
import { getPhiAgentDir } from './runtime-paths'
import {
  updateLatestCapabilityProfileMicromambaDownloadForHost,
  updateLatestCapabilityProfileMicromambaForHost
} from './workspace-host/capability-profile-store'
import { probeHostCapabilities } from './workspace-host/probe'
import { ensureRemoteMicromamba } from './workspace-host/remote-micromamba'
import type { HostCapabilityProfile } from './workspace-host/types'
import type { ConnectImpl } from './wrappers/executor-remote'
import { connectRemoteSshSession, type RemoteSshSession } from './wrappers/remote-ssh-session'

const REMOTE_OPERATION_TIMEOUT_MS = 5 * 60_000
const CURRENT_MICROMAMBA_VERSION = '2.9.0-0'

export type RemoteMicromambaSettingsStage =
  'probe' | 'download' | 'direct-download' | 'desktop-relay' | 'install'

export interface RemoteMicromambaSettingsProgress {
  stage: RemoteMicromambaSettingsStage
  message: string
  transferredBytes?: number
  totalBytes?: number
}

export interface RemoteMicromambaSettingsRequest {
  runtimeRoot: string
  downloadMirrorPrefix?: string
  confirmedWarnings?: readonly RemoteRuntimeRootWarningCode[]
  signal?: AbortSignal
  onProgress?: (progress: RemoteMicromambaSettingsProgress) => void
}

type HostProfile = NonNullable<ReturnType<typeof getRemoteHostProfile>>
type Platform = HostCapabilityProfile['platform']

export interface RemoteMicromambaSettingsDependencies {
  agentDir?: string
  getHostProfile?: (id: string, agentDir?: string) => HostProfile | undefined
  connect?: ConnectImpl
  probePlatform?: (session: RemoteSshSession) => Promise<Platform>
  describeArtifact?: typeof describeRemoteMicromambaArtifact
  getArtifact?: (
    platform: Platform,
    options?: Parameters<typeof getRemoteMicromambaArtifact>[1]
  ) => Promise<RemoteMicromambaArtifact>
  ensure?: typeof ensureRemoteMicromamba
  updateLatestProfile?: (
    hostAlias: string,
    status: RemoteMicromambaCapabilityProfile,
    agentDir?: string
  ) => boolean | void
  updateLatestDownloadProfile?: (
    hostAlias: string,
    download: RemoteMicromambaDownloadCapability,
    agentDir?: string
  ) => boolean | void
}

function targetFromArch(arch: string): RemoteMicromambaPlatform {
  return ['aarch64', 'arm64'].includes(arch) ? 'linux-arm64' : 'linux-x64'
}

function unsupportedResult(
  platform: Platform,
  error: unknown,
  startedAt: number
): RemoteMicromambaResult {
  const detail = error instanceof Error ? error.message : '不支持该远程平台'
  return {
    status: 'unsupported',
    version: CURRENT_MICROMAMBA_VERSION,
    platform: targetFromArch(platform.arch),
    durationMs: Date.now() - startedAt,
    warningCodes: [],
    errorCode: 'unsupported-platform',
    message: detail.startsWith('不支持') ? detail : '不支持该远程平台。'
  }
}

function failedResult(
  platform: Platform,
  startedAt: number,
  aborted: boolean
): RemoteMicromambaResult {
  return {
    status: 'failed',
    version: CURRENT_MICROMAMBA_VERSION,
    platform: targetFromArch(platform.arch),
    durationMs: Date.now() - startedAt,
    warningCodes: [],
    errorCode: aborted ? 'aborted' : 'invalid-artifact',
    message: aborted
      ? 'micromamba 安装已取消。'
      : 'micromamba 准备失败，请检查桌面网络、代理和缓存空间后重试。'
  }
}

function profileStatus(
  result: RemoteMicromambaResult
): RemoteMicromambaCapabilityProfile | undefined {
  if (result.status === 'installed' || result.status === 'already-installed') {
    return { status: 'installed', version: result.version }
  }
  if (
    result.status === 'failed' &&
    (result.errorCode === 'verification-failed' || result.errorCode === 'run-verification-failed')
  ) {
    return { status: 'unusable', version: result.version }
  }
  return undefined
}

async function defaultProbePlatform(session: RemoteSshSession): Promise<Platform> {
  return (await probeHostCapabilities(session, { timeoutMs: 30_000 })).platform
}

async function obtainArtifact(
  platform: Platform,
  request: RemoteMicromambaSettingsRequest,
  getArtifact: NonNullable<RemoteMicromambaSettingsDependencies['getArtifact']>,
  stage: 'download' | 'desktop-relay' = 'download'
): Promise<RemoteMicromambaArtifact> {
  request.onProgress?.({ stage, message: '正在准备本机中转的 micromamba 文件…' })
  return getArtifact(platform, {
    signal: request.signal,
    onProgress: ({ downloadedBytes, totalBytes }) =>
      request.onProgress?.({
        stage,
        message: '正在通过桌面端下载 micromamba 以进行本机中转…',
        transferredBytes: downloadedBytes,
        totalBytes
      })
  })
}

function installationInput(
  request: RemoteMicromambaSettingsRequest,
  artifact: RemoteMicromambaArtifact & { url?: string; urls?: readonly string[] },
  obtainLocalArtifact?: () => Promise<RemoteMicromambaArtifact>
): Parameters<typeof ensureRemoteMicromamba>[1] {
  return {
    runtimeRoot: request.runtimeRoot,
    confirmedWarnings: request.confirmedWarnings ?? [],
    artifact,
    obtainLocalArtifact,
    signal: request.signal,
    onProgress: (progress) =>
      request.onProgress?.({
        stage:
          progress.stage === 'remote-downloading'
            ? 'direct-download'
            : progress.stage === 'desktop-relay' || progress.stage === 'uploading'
              ? 'desktop-relay'
              : 'install',
        message: progress.message,
        transferredBytes: progress.transferredBytes,
        totalBytes: progress.totalBytes
      })
  }
}

function describedArtifact(
  platform: Platform,
  request: RemoteMicromambaSettingsRequest,
  dependencies: RemoteMicromambaSettingsDependencies
): RemoteMicromambaArtifactPlan & { urls: readonly string[] } {
  const artifact = (dependencies.describeArtifact ?? describeRemoteMicromambaArtifact)(platform, {
    agentDir: dependencies.agentDir
  })
  const userMirrorPrefix = normalizeRemoteMicromambaMirrorPrefix(request.downloadMirrorPrefix ?? '')
  return {
    ...artifact,
    urls: remoteMicromambaSourceUrls(artifact, userMirrorPrefix)
  }
}

async function legacyInstallation(
  session: RemoteSshSession,
  platform: Platform,
  request: RemoteMicromambaSettingsRequest,
  dependencies: RemoteMicromambaSettingsDependencies
): Promise<RemoteMicromambaResult> {
  const artifact = await obtainArtifact(platform, request, dependencies.getArtifact!)
  request.onProgress?.({ stage: 'install', message: '正在检查并安装远程 micromamba…' })
  return (dependencies.ensure ?? ensureRemoteMicromamba)(
    session,
    installationInput(request, artifact)
  )
}

async function runInstallation(
  session: RemoteSshSession,
  platform: Platform,
  request: RemoteMicromambaSettingsRequest,
  dependencies: RemoteMicromambaSettingsDependencies,
  startedAt: number
): Promise<RemoteMicromambaResult> {
  try {
    if (dependencies.getArtifact && !dependencies.describeArtifact) {
      return await legacyInstallation(session, platform, request, dependencies)
    }
    const artifact = describedArtifact(platform, request, dependencies)
    const getArtifact = dependencies.getArtifact ?? getRemoteMicromambaArtifact
    request.onProgress?.({ stage: 'install', message: '正在检查并安装远程 micromamba…' })
    return await (dependencies.ensure ?? ensureRemoteMicromamba)(
      session,
      installationInput(request, artifact, () =>
        obtainArtifact(platform, request, getArtifact, 'desktop-relay')
      )
    )
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('不支持')) {
      return unsupportedResult(platform, error, startedAt)
    }
    return failedResult(platform, startedAt, request.signal?.aborted === true)
  }
}

function persistCapabilityResult(
  hostAlias: string,
  result: RemoteMicromambaResult,
  agentDir: string,
  dependencies: RemoteMicromambaSettingsDependencies
): void {
  const status = profileStatus(result)
  if (status) {
    ;(dependencies.updateLatestProfile ?? updateLatestCapabilityProfileMicromambaForHost)(
      hostAlias,
      status,
      agentDir
    )
  }
  if (result.networkProbe) {
    ;(
      dependencies.updateLatestDownloadProfile ??
      updateLatestCapabilityProfileMicromambaDownloadForHost
    )(hostAlias, result.networkProbe, agentDir)
  }
}

export async function installRemoteMicromambaForHost(
  hostProfileId: string,
  request: RemoteMicromambaSettingsRequest,
  dependencies: RemoteMicromambaSettingsDependencies = {}
): Promise<RemoteMicromambaResult> {
  const startedAt = Date.now()
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
    request.onProgress?.({ stage: 'probe', message: '正在检测服务器平台…' })
    const platform = await (dependencies.probePlatform ?? defaultProbePlatform)(session)
    const result = await runInstallation(session, platform, request, dependencies, startedAt)
    persistCapabilityResult(profile.hostAlias, result, agentDir, dependencies)
    return result
  } finally {
    await session.close().catch(() => undefined)
  }
}
