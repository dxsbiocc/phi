import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import {
  type RemoteRipgrepErrorCode,
  type RemoteRipgrepInstallRequest,
  type RemoteRipgrepProgress,
  type RemoteRipgrepResult,
  type RemoteRipgrepStatusResult
} from '../../../shared/remoteRipgrepTypes'
import type {
  RemoteRuntimeRootCheckResult,
  RemoteRuntimeRootWarningCode
} from '../../../shared/remoteRuntimeRootTypes'
import { diagnoseRemoteCommandFailure } from '../remote-runtime/write-diagnostics'
import {
  shellQuote,
  type RemoteExecBoundedResult,
  type RemoteSshSession
} from '../wrappers/remote-ssh-session'
import { checkRemoteRuntimeRoot } from './runtime-root-check'
import {
  buildActivateRipgrepPrefixScript,
  buildCreateRipgrepPrefixCommand,
  buildPrepareRipgrepPrefixScript,
  buildWriteRipgrepMarkerCommand,
  findLatestMicromamba,
  findManagedRipgrep,
  findSystemRipgrep,
  parseRipgrepVersion,
  ripgrepSourceUnavailable,
  runBoundedRemoteCommand,
  validRemoteRipgrepRoot,
  verifyRemoteRipgrepCandidate,
  type RemoteExecutableCandidate
} from './remote-ripgrep-shell'
export { REMOTE_RIPGREP_COMPLETE_MARKER } from '../../../shared/remoteRipgrepTypes'
export type {
  RemoteRipgrepProgress,
  RemoteRipgrepResult,
  RemoteRipgrepStatusResult
} from '../../../shared/remoteRipgrepTypes'
const STATUS_TIMEOUT_MS = 10_000
const INSTALL_TIMEOUT_MS = 5 * 60_000
const MAX_STATUS_OUTPUT_BYTES = 32 * 1024
const MAX_INSTALL_OUTPUT_BYTES = 128 * 1024
type CheckRuntimeRoot = (
  session: Pick<RemoteSshSession, 'execWithInput'>,
  configuredRoot: string
) => Promise<RemoteRuntimeRootCheckResult>
export interface EnsureRemoteRipgrepOptions extends RemoteRipgrepInstallRequest {
  onProgress?: (progress: RemoteRipgrepProgress) => void
  signal?: AbortSignal
  checkRuntimeRoot?: CheckRuntimeRoot
  now?: () => number
  randomId?: () => string
}
type Candidate = RemoteExecutableCandidate
class InstallFailure extends Error {
  constructor(
    readonly code: RemoteRipgrepErrorCode,
    message: string
  ) {
    super(message)
  }
}
function duration(now: (() => number) | undefined, startedAt: number): number {
  return Math.max(0, (now ?? Date.now)() - startedAt)
}
function emit(options: EnsureRemoteRipgrepOptions, progress: RemoteRipgrepProgress): void {
  options.onProgress?.({ ...progress, requestId: options.requestId })
}
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new InstallFailure(
      'aborted',
      'Operation cancelled. No further ripgrep installation steps were performed.'
    )
}
function statusResult(
  candidate: Candidate | undefined,
  managed: boolean,
  startedAt: number,
  now?: () => number
): RemoteRipgrepStatusResult {
  if (!candidate) {
    return {
      status: 'not-installed',
      durationMs: duration(now, startedAt),
      message: 'No usable ripgrep is installed on the server.'
    }
  }
  return {
    status: managed ? 'managed' : 'system',
    executablePath: candidate.executablePath,
    version: candidate.version,
    durationMs: duration(now, startedAt),
    message: managed
      ? 'Managed remote ripgrep is installed and runnable.'
      : 'System ripgrep is already available on the server.'
  }
}
export async function getRemoteRipgrepStatus(
  session: RemoteSshSession,
  runtimeRoot: string
): Promise<RemoteRipgrepStatusResult> {
  const startedAt = Date.now()
  if (!validRemoteRipgrepRoot(runtimeRoot)) {
    return {
      status: 'failed',
      durationMs: duration(undefined, startedAt),
      errorCode: 'status-check-failed',
      message: 'Invalid runtime root path. Unable to check ripgrep status.'
    }
  }
  try {
    const system = await findSystemRipgrep(session)
    if (system) return statusResult(system, false, startedAt)
    return statusResult(await findManagedRipgrep(session, runtimeRoot), true, startedAt)
  } catch {
    return {
      status: 'failed',
      durationMs: duration(undefined, startedAt),
      errorCode: 'status-check-failed',
      message: 'Unable to read remote ripgrep status. Check the connection and retry.'
    }
  }
}
function stoppedByRootCheck(
  options: EnsureRemoteRipgrepOptions,
  check: RemoteRuntimeRootCheckResult,
  startedAt: number
): RemoteRipgrepResult | undefined {
  const warningCodes = check.warnings.map(({ code }) => code)
  const common = { durationMs: duration(options.now, startedAt), warningCodes }
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
  if (warningCodes.some((code) => !confirmed.has(code))) {
    return {
      ...common,
      status: 'needs-confirmation',
      message:
        'The runtime root has risks requiring confirmation. Select “Use anyway” to install ripgrep.'
    }
  }
  return undefined
}
async function prepareTemporaryPrefix(
  session: RemoteSshSession,
  root: string,
  temporaryPrefix: string,
  signal?: AbortSignal
): Promise<void> {
  const command = buildPrepareRipgrepPrefixScript(root, temporaryPrefix)
  const result = await runBoundedRemoteCommand(
    session,
    command,
    STATUS_TIMEOUT_MS,
    8 * 1024,
    signal
  )
  if (result.code !== 0) {
    throw new InstallFailure(
      'installation-failed',
      'Unable to safely create the ripgrep installation directory. Check permissions.'
    )
  }
}
async function createPrefix(
  session: RemoteSshSession,
  root: string,
  mamba: Candidate,
  temporaryPrefix: string,
  signal?: AbortSignal
): Promise<boolean> {
  const result = await runCreatePrefix(session, root, mamba, temporaryPrefix, false, signal)
  assertNotAborted(signal)
  if (result.code === 0) return false
  if (ripgrepSourceUnavailable(`${result.stdout}\n${result.stderr}`)) {
    const offline = await runCreatePrefix(session, root, mamba, temporaryPrefix, true, signal)
    assertNotAborted(signal)
    if (offline.code === 0) return true
    await throwDiagnosedInstallFailure(session, root, offline, signal)
    throw new InstallFailure(
      'source-unreachable',
      'The conda source is unreachable and the local cache is insufficient. Configure an available mirror, or prebuild on a machine with network access.'
    )
  }
  await throwDiagnosedInstallFailure(session, root, result, signal)
  throw new InstallFailure(
    'installation-failed',
    'micromamba did not complete the ripgrep installation.'
  )
}
async function runCreatePrefix(
  session: RemoteSshSession,
  root: string,
  mamba: Candidate,
  temporaryPrefix: string,
  offline: boolean,
  signal?: AbortSignal
): Promise<RemoteExecBoundedResult> {
  const command = buildCreateRipgrepPrefixCommand(
    root,
    mamba.executablePath,
    temporaryPrefix,
    offline
  )
  return runBoundedRemoteCommand(
    session,
    command,
    INSTALL_TIMEOUT_MS,
    MAX_INSTALL_OUTPUT_BYTES,
    signal
  )
}
async function throwDiagnosedInstallFailure(
  session: RemoteSshSession,
  root: string,
  result: Awaited<ReturnType<typeof runBoundedRemoteCommand>>,
  signal?: AbortSignal
): Promise<void> {
  const diagnosis = await diagnoseRemoteCommandFailure(
    {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      terminationReason: result.signal ? 'terminated' : undefined
    },
    root,
    (script) => runBoundedRemoteCommand(session, script, STATUS_TIMEOUT_MS, 8 * 1024, signal)
  )
  if (diagnosis && diagnosis.kind !== 'other') {
    throw new InstallFailure('installation-failed', diagnosis.message)
  }
}
async function writeMarker(
  session: RemoteSshSession,
  temporaryPrefix: string,
  version: string,
  signal?: AbortSignal
): Promise<void> {
  const command = buildWriteRipgrepMarkerCommand(temporaryPrefix, version)
  const result = await runBoundedRemoteCommand(
    session,
    command,
    STATUS_TIMEOUT_MS,
    8 * 1024,
    signal
  )
  if (result.code !== 0) {
    throw new InstallFailure(
      'activation-failed',
      'Unable to write the ripgrep installation completion marker.'
    )
  }
}
async function activatePrefix(
  session: RemoteSshSession,
  temporaryPrefix: string,
  finalPrefix: string,
  version: string,
  signal?: AbortSignal
): Promise<'activated' | 'existing'> {
  const command = buildActivateRipgrepPrefixScript(temporaryPrefix, finalPrefix, version)
  const result = await runBoundedRemoteCommand(
    session,
    command,
    STATUS_TIMEOUT_MS,
    8 * 1024,
    signal
  )
  if (result.code === 0) return 'activated'
  if (result.code === 17) return 'existing'
  throw new InstallFailure(
    'activation-failed',
    'Unable to activate the ripgrep installation directory atomically.'
  )
}
async function cleanupPrefix(session: RemoteSshSession, temporaryPrefix: string): Promise<void> {
  await runBoundedRemoteCommand(
    session,
    `rm -rf -- ${shellQuote(temporaryPrefix)}`,
    STATUS_TIMEOUT_MS,
    8 * 1024
  ).catch(() => undefined)
}
function successfulResult(
  options: EnsureRemoteRipgrepOptions,
  startedAt: number,
  warnings: readonly RemoteRuntimeRootWarningCode[],
  candidate: Candidate,
  installed: boolean,
  usedOfflineCache = false
): RemoteRipgrepResult {
  return {
    status: installed ? 'installed' : 'already-installed',
    executablePath: candidate.executablePath,
    version: candidate.version,
    durationMs: duration(options.now, startedAt),
    warningCodes: warnings,
    message: installed
      ? usedOfflineCache
        ? 'Managed remote ripgrep installed and verified successfully using the local cache.'
        : 'Managed remote ripgrep installed and verified successfully.'
      : 'Managed remote ripgrep is installed and runnable.'
  }
}
async function installManaged(
  session: RemoteSshSession,
  options: EnsureRemoteRipgrepOptions,
  root: string,
  warnings: readonly RemoteRuntimeRootWarningCode[],
  startedAt: number
): Promise<RemoteRipgrepResult> {
  const mamba = await findLatestMicromamba(session, root, options.signal)
  assertNotAborted(options.signal)
  if (!mamba) {
    throw new InstallFailure(
      'micromamba-not-installed',
      'No usable micromamba was detected. Select “Install micromamba” in Settings → Remote Hosts first.'
    )
  }
  const randomId = (options.randomId ?? (() => randomBytes(8).toString('hex')))()
  if (!/^[A-Za-z0-9_-]+$/.test(randomId))
    throw new InstallFailure('installation-failed', 'Invalid installation identifier.')
  const temporaryPrefix = posix.join(root, 'tools', `.ripgrep-install-${randomId}`)
  emit(options, {
    stage: 'preparing-directory',
    message: 'Preparing the ripgrep installation directory…'
  })
  await prepareTemporaryPrefix(session, root, temporaryPrefix, options.signal)
  try {
    return await populateAndActivatePrefix(
      session,
      options,
      root,
      mamba,
      temporaryPrefix,
      warnings,
      startedAt
    )
  } finally {
    await cleanupPrefix(session, temporaryPrefix)
  }
}
async function populateAndActivatePrefix(
  session: RemoteSshSession,
  options: EnsureRemoteRipgrepOptions,
  root: string,
  mamba: Candidate,
  temporaryPrefix: string,
  warnings: readonly RemoteRuntimeRootWarningCode[],
  startedAt: number
): Promise<RemoteRipgrepResult> {
  emit(options, { stage: 'remote-downloading', message: 'Installing ripgrep through micromamba…' })
  const usedOfflineCache = await createPrefix(session, root, mamba, temporaryPrefix, options.signal)
  assertNotAborted(options.signal)
  emit(options, { stage: 'verifying-installation', message: 'Verifying ripgrep…' })
  const executablePath = posix.join(temporaryPrefix, 'bin', 'rg')
  const verify = await runBoundedRemoteCommand(
    session,
    `${shellQuote(executablePath)} --version`,
    STATUS_TIMEOUT_MS,
    MAX_STATUS_OUTPUT_BYTES,
    options.signal
  )
  const version = verify.code === 0 ? parseRipgrepVersion(verify.stdout) : undefined
  if (!version)
    throw new InstallFailure(
      'verification-failed',
      'ripgrep was installed but version verification failed.'
    )
  await writeMarker(session, temporaryPrefix, version, options.signal)
  const finalPrefix = posix.join(root, 'tools', `ripgrep-${version}`)
  emit(options, { stage: 'activating', message: 'Activating managed ripgrep…' })
  const activation = await activatePrefix(
    session,
    temporaryPrefix,
    finalPrefix,
    version,
    options.signal
  )
  const candidate = { version, executablePath: posix.join(finalPrefix, 'bin', 'rg') }
  if (!(await verifyRemoteRipgrepCandidate(session, candidate, options.signal))) {
    throw new InstallFailure(
      'verification-failed',
      'Managed ripgrep verification failed after activation.'
    )
  }
  emit(options, { stage: 'complete', message: 'Remote ripgrep installation complete.' })
  return successfulResult(
    options,
    startedAt,
    warnings,
    candidate,
    activation === 'activated',
    usedOfflineCache
  )
}
async function existingRipgrepResult(
  session: RemoteSshSession,
  options: EnsureRemoteRipgrepOptions,
  startedAt: number
): Promise<RemoteRipgrepResult | undefined> {
  if (!options.forceManaged) {
    const system = await findSystemRipgrep(session, options.signal)
    assertNotAborted(options.signal)
    if (system) {
      return {
        ...successfulResult(options, startedAt, [], system, false),
        status: 'system',
        message: 'System ripgrep is already available on the server. No installation is needed.'
      }
    }
  }
  const managed = await findManagedRipgrep(session, options.runtimeRoot, options.signal)
  return managed ? successfulResult(options, startedAt, [], managed, false) : undefined
}
function failedInstallResult(
  error: unknown,
  options: EnsureRemoteRipgrepOptions,
  startedAt: number
): RemoteRipgrepResult {
  const failure =
    error instanceof InstallFailure
      ? error
      : options.signal?.aborted
        ? new InstallFailure(
            'aborted',
            'Operation cancelled. No further ripgrep installation steps were performed.'
          )
        : new InstallFailure('installation-failed', 'Remote ripgrep installation failed.')
  return {
    status: 'failed',
    durationMs: duration(options.now, startedAt),
    warningCodes: [],
    errorCode: failure.code,
    message: failure.message
  }
}
export async function ensureRemoteRipgrep(
  session: RemoteSshSession,
  options: EnsureRemoteRipgrepOptions
): Promise<RemoteRipgrepResult> {
  const startedAt = (options.now ?? Date.now)()
  if (!validRemoteRipgrepRoot(options.runtimeRoot)) {
    return {
      status: 'failed',
      durationMs: duration(options.now, startedAt),
      warningCodes: [],
      errorCode: 'runtime-root-check-failed',
      message: 'Invalid runtime root path. Unable to install ripgrep.'
    }
  }
  try {
    assertNotAborted(options.signal)
    emit(options, { stage: 'checking-existing', message: 'Checking remote ripgrep…' })
    const existing = await existingRipgrepResult(session, options, startedAt)
    if (existing) return existing
    emit(options, { stage: 'checking-runtime-root', message: 'Checking the remote runtime root…' })
    const check = await (options.checkRuntimeRoot ?? checkRemoteRuntimeRoot)(
      session,
      options.runtimeRoot
    )
    assertNotAborted(options.signal)
    const stopped = stoppedByRootCheck(options, check, startedAt)
    if (stopped) return stopped
    const root = check.expandedPath as string
    const warnings = check.warnings.map(({ code }) => code)
    return await installManaged(session, options, root, warnings, startedAt)
  } catch (error) {
    return failedInstallResult(error, options, startedAt)
  }
}
