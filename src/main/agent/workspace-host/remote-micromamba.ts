import { posix } from 'node:path'

import {
  remoteMicromambaPath,
  type RemoteMicromambaArtifact,
  type RemoteMicromambaErrorCode,
  type RemoteMicromambaInstallRequest,
  type RemoteMicromambaProgress,
  type RemoteMicromambaResult,
  type RemoteMicromambaVerification
} from '../../../shared/remoteMicromambaTypes'
import type {
  RemoteRuntimeRootCheckResult,
  RemoteRuntimeRootWarningCode
} from '../../../shared/remoteRuntimeRootTypes'
import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
import type { RemoteStdioProcess } from '../wrappers/remote-ssh-session'
import type { FileTransferCoordinator, TransferEvent } from '../transfer'
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
  transferCoordinator?: FileTransferCoordinator
  transferHostKey?: string
  transferWorkspaceId?: string
  helperConnect?: () => Promise<RemoteStdioProcess>
  helperVersion?: string
  agentDir?: string
  onTransferEvent?: (event: TransferEvent) => void
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
  if (signal?.aborted)
    throw new InstallFailure(
      'aborted',
      'Operation cancelled. No further changes were made to the remote runtime.'
    )
}

async function prepareDirectories(context: OperationContext): Promise<void> {
  emit(context.options, {
    stage: 'preparing-directory',
    message: 'Preparing the remote runtime directory…'
  })
  assertNotAborted(context.options.signal)
  const result = await runRemoteMicromambaScript(
    context.session,
    buildPrepareRuntimeScript(context.root, posix.dirname(context.installPath))
  )
  if (result.code !== 0) {
    throw new InstallFailure(
      'directory-creation-failed',
      'Unable to create the remote runtime directory. Check write permissions.'
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
    runSuccessful: parsed.runSuccessful,
    runnable: parsed.runnable
  }
}

async function installOrReuse(context: OperationContext): Promise<RemoteMicromambaResult> {
  await prepareDirectories(context)
  emit(context.options, { stage: 'checking-existing', message: 'Checking installed versions…' })
  const existingHash = await readRemoteMicromambaHash(context.session, context.installPath)
  if (existingHash === context.options.artifact.sha256) {
    const verification = await verifyInstalled(context)
    if (verification.runnable && verification.versionMatches && verification.platformMatches) {
      return {
        ...baseResult(context.options, context.startedAt, context.warningCodes),
        status: 'already-installed',
        installPath: context.installPath,
        message: 'Remote micromamba is already at the required version.',
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
    randomId: context.options.randomId,
    transferCoordinator: context.options.transferCoordinator,
    transferHostKey: context.options.transferHostKey,
    transferWorkspaceId: context.options.transferWorkspaceId,
    helperConnect: context.options.helperConnect,
    helperVersion: context.options.helperVersion,
    agentDir: context.options.agentDir,
    onTransferEvent: context.options.onTransferEvent
  })
  emit(context.options, {
    stage: 'verifying-installation',
    message: 'Verifying remote micromamba…'
  })
  const verification = await verifyInstalled(context)
  if (!verification.runnable || !verification.versionMatches || !verification.platformMatches) {
    const runFailed =
      verification.versionMatches && verification.platformMatches && !verification.runSuccessful
    throw new InstallFailure(
      runFailed ? 'run-verification-failed' : 'verification-failed',
      runFailed
        ? 'micromamba was transferred, but micromamba run activation verification failed.'
        : 'micromamba was transferred, but version or platform verification failed.',
      verification,
      transfer
    )
  }
  emit(context.options, { stage: 'complete', message: 'Remote micromamba installation complete.' })
  return {
    ...baseResult(context.options, context.startedAt, context.warningCodes),
    status: 'installed',
    installPath: context.installPath,
    message: 'Remote micromamba installed and verified successfully.',
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
      message:
        'The remote runtime root does not meet installation requirements. Change the location and retry.'
    }
  }
  if (check.status !== 'checked' || !check.expandedPath) {
    return {
      ...common,
      status: 'failed',
      errorCode: 'runtime-root-check-failed',
      message:
        check.status === 'timed-out'
          ? 'The server is responding slowly and the runtime root check timed out. Retry later.'
          : 'Unable to verify the remote runtime root. Check the connection and directory permissions.'
    }
  }
  const confirmed = new Set(options.confirmedWarnings)
  const pendingWarnings = check.warnings.filter(({ code }) => !confirmed.has(code))
  if (pendingWarnings.length > 0) {
    const hasNoexec = pendingWarnings.some(({ code }) => code === 'noexec')
    return {
      ...common,
      status: 'needs-confirmation',
      installPath: remoteMicromambaPath(check.expandedPath, options.artifact.version),
      message: hasNoexec
        ? 'This location is mounted noexec, so micromamba cannot run. Choose a location that allows execution. Select “Use anyway” to attempt installation and verify the result.'
        : 'The runtime root has risks requiring confirmation. Select “Use anyway” to install.'
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
          ? 'micromamba installation does not support this remote platform.'
          : 'Invalid micromamba installation artifact metadata.'
    }
  }
  emit(options, { stage: 'checking-runtime-root', message: 'Checking the remote runtime root…' })
  const check = await (options.checkRuntimeRoot ?? checkRemoteRuntimeRoot)(
    session,
    options.runtimeRoot
  )
  const stopped = checkFailureResult(options, startedAt, check)
  if (stopped) return stopped
  const root = check.expandedPath as string
  const warningCodes = check.warnings.map(({ code }) => code)
  const installPath = remoteMicromambaPath(root, options.artifact.version)
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
  return new InstallFailure('upload-failed', 'Remote micromamba installation failed.')
}
