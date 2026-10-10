import { posix } from 'node:path'

import type {
  RemoteMicromambaArtifact,
  RemoteMicromambaErrorCode,
  RemoteMicromambaInstallRequest,
  RemoteMicromambaProgress,
  RemoteMicromambaResult,
  RemoteMicromambaVerification
} from '../../../shared/remoteMicromambaTypes'
import type {
  RemoteRuntimeRootCheckResult,
  RemoteRuntimeRootWarningCode
} from '../../../shared/remoteRuntimeRootTypes'
import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
import { checkRemoteRuntimeRoot } from './runtime-root-check'
import {
  expectedRemoteMicromambaInfoPlatform,
  remoteMicromambaBinaryVersion,
  runRemoteMicromambaScript
} from './remote-micromamba-common'
import {
  buildPrepareRuntimeScript,
  buildVerificationScript,
  parseVerification
} from './remote-micromamba-shell'
import {
  readRemoteMicromambaHash,
  RemoteMicromambaTransferFailure,
  transferRemoteMicromamba,
  type RemoteMicromambaArtifactPlan,
  type RemoteMicromambaTransferResult
} from './remote-micromamba-transfer'

export type {
  RemoteMicromambaArtifact,
  RemoteMicromambaInstallRequest,
  RemoteMicromambaProgress,
  RemoteMicromambaResult,
  RemoteMicromambaStatusResult
} from '../../../shared/remoteMicromambaTypes'
export { remoteMicromambaBinaryVersion } from './remote-micromamba-common'
export {
  getRemoteMicromambaStatus,
  type GetRemoteMicromambaStatusOptions
} from './remote-micromamba-status'

type CheckRuntimeRoot = (
  session: Pick<RemoteSshSession, 'execWithInput'>,
  configuredRoot: string
) => Promise<RemoteRuntimeRootCheckResult>

export interface EnsureRemoteMicromambaOptions extends RemoteMicromambaInstallRequest {
  artifact: RemoteMicromambaArtifactPlan
  obtainLocalArtifact?: () => Promise<RemoteMicromambaArtifact>
  onProgress?: (progress: RemoteMicromambaProgress) => void
  signal?: AbortSignal
  checkRuntimeRoot?: CheckRuntimeRoot
  now?: () => number
  randomId?: () => string
}

interface OperationContext {
  session: RemoteSshSession
  options: EnsureRemoteMicromambaOptions
  startedAt: number
  root: string
  installPath: string
  warningCodes: readonly RemoteRuntimeRootWarningCode[]
}

class InstallFailure extends Error {
  constructor(
    readonly code: RemoteMicromambaErrorCode,
    message: string,
    readonly verification?: RemoteMicromambaResult['verification'],
    readonly transfer?: RemoteMicromambaTransferResult
  ) {
    super(message)
  }
}

function emit(options: EnsureRemoteMicromambaOptions, progress: RemoteMicromambaProgress): void {
  options.onProgress?.({ ...progress, requestId: options.requestId })
}

function duration(options: EnsureRemoteMicromambaOptions, startedAt: number): number {
  return Math.max(0, (options.now ?? Date.now)() - startedAt)
}

function checkedArtifact(
  artifact: RemoteMicromambaArtifactPlan
): RemoteMicromambaErrorCode | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(artifact.version)) return 'invalid-artifact'
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || artifact.size < 1) return 'invalid-artifact'
  if (!['linux-x64', 'linux-arm64'].includes(artifact.platform)) return 'unsupported-platform'
  const urls = [...(artifact.url ? [artifact.url] : []), ...(artifact.urls ?? [])]
  for (const candidate of urls) {
    try {
      const url = new URL(candidate)
      if (url.protocol !== 'https:' || url.username || url.password) return 'invalid-artifact'
    } catch {
      return 'invalid-artifact'
    }
  }
  return undefined
}

function baseResult(
  options: EnsureRemoteMicromambaOptions,
  startedAt: number,
  warningCodes: readonly RemoteRuntimeRootWarningCode[]
): Pick<RemoteMicromambaResult, 'version' | 'platform' | 'durationMs' | 'warningCodes'> {
  return {
    version: options.artifact.version,
    platform: options.artifact.platform,
    durationMs: duration(options, startedAt),
    warningCodes
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new InstallFailure('aborted', '操作已取消，未继续修改远端运行时。')
}

async function prepareDirectories(context: OperationContext): Promise<void> {
  emit(context.options, { stage: 'preparing-directory', message: '正在准备远端运行时目录…' })
  assertNotAborted(context.options.signal)
  const result = await runRemoteMicromambaScript(
    context.session,
    buildPrepareRuntimeScript(context.root)
  )
  if (result.code !== 0) {
    throw new InstallFailure(
      'directory-creation-failed',
      '无法创建远端运行时目录，请检查写入权限。'
    )
  }
}

async function verifyInstalled(context: OperationContext): Promise<RemoteMicromambaVerification> {
  const result = await runRemoteMicromambaScript(
    context.session,
    buildVerificationScript(context.installPath, context.root)
  )
  const parsed = parseVerification(result.stdout, result.code)
  return {
    version: parsed.version,
    platform: parsed.platform,
    versionMatches:
      parsed.version === remoteMicromambaBinaryVersion(context.options.artifact.version),
    platformMatches:
      parsed.platform === expectedRemoteMicromambaInfoPlatform(context.options.artifact.platform),
    runnable: parsed.runnable
  }
}

async function installOrReuse(context: OperationContext): Promise<RemoteMicromambaResult> {
  await prepareDirectories(context)
  emit(context.options, { stage: 'checking-existing', message: '正在检查已安装版本…' })
  const existingHash = await readRemoteMicromambaHash(context.session, context.installPath)
  if (existingHash === context.options.artifact.sha256) {
    const verification = await verifyInstalled(context)
    if (verification.runnable && verification.versionMatches && verification.platformMatches) {
      return {
        ...baseResult(context.options, context.startedAt, context.warningCodes),
        status: 'already-installed',
        installPath: context.installPath,
        message: '远端 micromamba 已是所需版本。',
        verification,
        transferMethod: 'existing'
      }
    }
  }
  const transfer = await transferRemoteMicromamba({
    session: context.session,
    artifact: context.options.artifact,
    installPath: context.installPath,
    obtainLocalArtifact: context.options.obtainLocalArtifact,
    onProgress: (progress) => emit(context.options, progress),
    signal: context.options.signal,
    randomId: context.options.randomId
  })
  emit(context.options, { stage: 'verifying-installation', message: '正在验证远端 micromamba…' })
  const verification = await verifyInstalled(context)
  if (!verification.runnable || !verification.versionMatches || !verification.platformMatches) {
    throw new InstallFailure(
      'verification-failed',
      'micromamba 已传输，但运行或平台验证失败。',
      verification,
      transfer
    )
  }
  emit(context.options, { stage: 'complete', message: '远端 micromamba 安装完成。' })
  return {
    ...baseResult(context.options, context.startedAt, context.warningCodes),
    status: 'installed',
    installPath: context.installPath,
    message: '远端 micromamba 安装并验证成功。',
    verification,
    ...transfer
  }
}

function checkFailureResult(
  options: EnsureRemoteMicromambaOptions,
  startedAt: number,
  check: RemoteRuntimeRootCheckResult
): RemoteMicromambaResult | undefined {
  const common = baseResult(
    options,
    startedAt,
    check.warnings.map(({ code }) => code)
  )
  if (check.hardErrors.length > 0) {
    return {
      ...common,
      status: 'failed',
      errorCode: 'runtime-root-hard-error',
      message: '远端运行时根目录不满足安装要求，请修改位置后重试。'
    }
  }
  if (check.status !== 'checked' || !check.expandedPath) {
    return {
      ...common,
      status: 'failed',
      errorCode: 'runtime-root-check-failed',
      message: '无法确认远端运行时根目录，请重新检查连接与目录权限。'
    }
  }
  const confirmed = new Set(options.confirmedWarnings)
  const pendingWarnings = check.warnings.filter(({ code }) => !confirmed.has(code))
  if (pendingWarnings.length > 0) {
    const hasNoexec = pendingWarnings.some(({ code }) => code === 'noexec')
    return {
      ...common,
      status: 'needs-confirmation',
      installPath: posix.join(check.expandedPath, 'bin', `micromamba-${options.artifact.version}`),
      message: hasNoexec
        ? '该位置为 noexec，micromamba 将无法运行；建议更换可执行位置。确认“仍然使用”后仍可尝试安装并如实验证。'
        : '运行时根目录存在需要确认的风险，确认“仍然使用”后才能安装。'
    }
  }
  return undefined
}

export async function ensureRemoteMicromamba(
  session: RemoteSshSession,
  options: EnsureRemoteMicromambaOptions
): Promise<RemoteMicromambaResult> {
  const startedAt = (options.now ?? Date.now)()
  const invalid = checkedArtifact(options.artifact)
  if (invalid) {
    return {
      ...baseResult(options, startedAt, []),
      status: invalid === 'unsupported-platform' ? 'unsupported' : 'failed',
      errorCode: invalid,
      message:
        invalid === 'unsupported-platform'
          ? '该远端平台不受 micromamba 安装支持。'
          : 'micromamba 安装包信息无效。'
    }
  }
  emit(options, { stage: 'checking-runtime-root', message: '正在检查远端运行时根目录…' })
  const check = await (options.checkRuntimeRoot ?? checkRemoteRuntimeRoot)(
    session,
    options.runtimeRoot
  )
  const stopped = checkFailureResult(options, startedAt, check)
  if (stopped) return stopped
  const root = check.expandedPath as string
  const warningCodes = check.warnings.map(({ code }) => code)
  const installPath = posix.join(root, 'bin', `micromamba-${options.artifact.version}`)
  try {
    return await installOrReuse({ session, options, startedAt, root, installPath, warningCodes })
  } catch (error) {
    const failure = normalizeInstallFailure(error)
    const transfer =
      failure instanceof InstallFailure
        ? failure.transfer
        : { networkProbe: failure.networkProbe, transferMethod: failure.transferMethod }
    return {
      ...baseResult(options, startedAt, warningCodes),
      status: 'failed',
      installPath,
      errorCode: failure.code,
      message: failure.message,
      verification: failure instanceof InstallFailure ? failure.verification : undefined,
      ...transfer
    }
  }
}

function normalizeInstallFailure(error: unknown): InstallFailure | RemoteMicromambaTransferFailure {
  if (error instanceof InstallFailure || error instanceof RemoteMicromambaTransferFailure) {
    return error
  }
  return new InstallFailure('upload-failed', '安装远端 micromamba 失败。')
}
