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
import { shellQuote, type RemoteSshSession } from '../wrappers/remote-ssh-session'
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
  if (signal?.aborted) throw new InstallFailure('aborted', '操作已取消，未继续安装 ripgrep。')
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
      message: '远端尚未安装可用的 ripgrep。'
    }
  }
  return {
    status: managed ? 'managed' : 'system',
    executablePath: candidate.executablePath,
    version: candidate.version,
    durationMs: duration(now, startedAt),
    message: managed ? '远端受管 ripgrep 已安装且可运行。' : '远端已有系统 ripgrep。'
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
      message: '运行时根目录写法无效，无法检查 ripgrep 状态。'
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
      message: '无法读取远端 ripgrep 状态，请检查连接后重试。'
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
  if (warningCodes.some((code) => !confirmed.has(code))) {
    return {
      ...common,
      status: 'needs-confirmation',
      message: '运行时根目录存在需要确认的风险，确认“仍然使用”后才能安装 ripgrep。'
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
    throw new InstallFailure('installation-failed', '无法安全创建 ripgrep 安装目录，请检查权限。')
  }
}
async function createPrefix(
  session: RemoteSshSession,
  root: string,
  mamba: Candidate,
  temporaryPrefix: string,
  signal?: AbortSignal
): Promise<void> {
  const command = buildCreateRipgrepPrefixCommand(root, mamba.executablePath, temporaryPrefix)
  const result = await runBoundedRemoteCommand(
    session,
    command,
    INSTALL_TIMEOUT_MS,
    MAX_INSTALL_OUTPUT_BYTES,
    signal
  )
  if (result.code === 0) return
  if (ripgrepSourceUnavailable(`${result.stdout}\n${result.stderr}`)) {
    throw new InstallFailure(
      'source-unreachable',
      '无法访问 conda 软件源；请配置可用镜像，或在可联网机器预构建后再使用。'
    )
  }
  throw new InstallFailure('installation-failed', 'micromamba 未能完成 ripgrep 安装。')
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
    throw new InstallFailure('activation-failed', '无法写入 ripgrep 安装完成标记。')
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
  throw new InstallFailure('activation-failed', '无法原子激活 ripgrep 安装目录。')
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
  installed: boolean
): RemoteRipgrepResult {
  return {
    status: installed ? 'installed' : 'already-installed',
    executablePath: candidate.executablePath,
    version: candidate.version,
    durationMs: duration(options.now, startedAt),
    warningCodes: warnings,
    message: installed ? '远端受管 ripgrep 安装并验证成功。' : '远端受管 ripgrep 已安装且可运行。'
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
      '未检测到可用的 micromamba；请先在设置 → 远程主机点击“安装 micromamba”。'
    )
  }
  const randomId = (options.randomId ?? (() => randomBytes(8).toString('hex')))()
  if (!/^[A-Za-z0-9_-]+$/.test(randomId))
    throw new InstallFailure('installation-failed', '安装标识无效。')
  const temporaryPrefix = posix.join(root, 'tools', `.ripgrep-install-${randomId}`)
  emit(options, { stage: 'preparing-directory', message: '正在准备 ripgrep 安装目录…' })
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
  emit(options, { stage: 'remote-downloading', message: '正在通过 micromamba 安装 ripgrep…' })
  await createPrefix(session, root, mamba, temporaryPrefix, options.signal)
  assertNotAborted(options.signal)
  emit(options, { stage: 'verifying-installation', message: '正在验证 ripgrep…' })
  const executablePath = posix.join(temporaryPrefix, 'bin', 'rg')
  const verify = await runBoundedRemoteCommand(
    session,
    `${shellQuote(executablePath)} --version`,
    STATUS_TIMEOUT_MS,
    MAX_STATUS_OUTPUT_BYTES,
    options.signal
  )
  const version = verify.code === 0 ? parseRipgrepVersion(verify.stdout) : undefined
  if (!version) throw new InstallFailure('verification-failed', 'ripgrep 已安装但版本验证失败。')
  await writeMarker(session, temporaryPrefix, version, options.signal)
  const finalPrefix = posix.join(root, 'tools', `ripgrep-${version}`)
  emit(options, { stage: 'activating', message: '正在激活受管 ripgrep…' })
  const activation = await activatePrefix(
    session,
    temporaryPrefix,
    finalPrefix,
    version,
    options.signal
  )
  const candidate = { version, executablePath: posix.join(finalPrefix, 'bin', 'rg') }
  if (!(await verifyRemoteRipgrepCandidate(session, candidate, options.signal))) {
    throw new InstallFailure('verification-failed', '受管 ripgrep 激活后验证失败。')
  }
  emit(options, { stage: 'complete', message: '远端 ripgrep 安装完成。' })
  return successfulResult(options, startedAt, warnings, candidate, activation === 'activated')
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
        message: '远端已有系统 ripgrep，无需重复安装。'
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
        ? new InstallFailure('aborted', '操作已取消，未继续安装 ripgrep。')
        : new InstallFailure('installation-failed', '远端 ripgrep 安装失败。')
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
      message: '运行时根目录写法无效，无法安装 ripgrep。'
    }
  }
  try {
    assertNotAborted(options.signal)
    emit(options, { stage: 'checking-existing', message: '正在检查远端 ripgrep…' })
    const existing = await existingRipgrepResult(session, options, startedAt)
    if (existing) return existing
    emit(options, { stage: 'checking-runtime-root', message: '正在检查远端运行时根目录…' })
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
