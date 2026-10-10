import {
  remoteMicromambaPath,
  type RemoteMicromambaErrorCode,
  type RemoteMicromambaPlatform,
  type RemoteMicromambaStatusResult
} from '../../../shared/remoteMicromambaTypes'
import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
import {
  expectedRemoteMicromambaInfoPlatform,
  remoteMicromambaBinaryVersion,
  runRemoteMicromambaScript
} from './remote-micromamba-common'
import {
  buildStatusScanScript,
  buildVerificationScript,
  parseStatusScan,
  parseVerification
} from './remote-micromamba-shell'

export interface GetRemoteMicromambaStatusOptions {
  expectedVersion?: string
  platform?: RemoteMicromambaPlatform
  now?: () => number
}

type StatusBase = Omit<
  RemoteMicromambaStatusResult,
  'status' | 'versionMatches' | 'runnable' | 'message'
>

function validConfiguredRoot(root: string): boolean {
  return (
    Boolean(root) &&
    !/[\0\r\n]/.test(root) &&
    (root.startsWith('/') || root.startsWith('~/')) &&
    !root.split('/').includes('..')
  )
}

function statusBase(
  options: GetRemoteMicromambaStatusOptions,
  startedAt: number,
  installedVersions: readonly string[]
): StatusBase {
  return {
    installedVersions,
    expectedVersion: options.expectedVersion,
    platform: options.platform,
    durationMs: Math.max(0, (options.now ?? Date.now)() - startedAt),
    warningCodes: []
  }
}

function failedStatus(base: StatusBase, message: string): RemoteMicromambaStatusResult {
  return {
    ...base,
    status: 'failed',
    versionMatches: null,
    runnable: null,
    errorCode: 'status-check-failed',
    message
  }
}

function notInstalledStatus(
  base: StatusBase,
  hasExpectedVersion: boolean
): RemoteMicromambaStatusResult {
  return {
    ...base,
    status: 'not-installed',
    versionMatches: hasExpectedVersion ? false : null,
    runnable: false,
    message: '远端尚未安装 micromamba。'
  }
}

function legacyLayoutStatus(
  base: StatusBase,
  expectedVersion: string | undefined,
  legacyVersions: readonly string[]
): RemoteMicromambaStatusResult {
  return {
    ...base,
    status: 'unusable',
    versionMatches: expectedVersion ? legacyVersions.includes(expectedVersion) : null,
    runnable: false,
    errorCode: 'legacy-layout',
    message: '检测到 R2.2 旧安装布局，不能用于 micromamba run；请重新安装以完成迁移。'
  }
}

async function verifyStatusTarget(
  session: RemoteSshSession,
  root: string,
  release: string,
  platform: RemoteMicromambaPlatform | undefined
): Promise<{
  runnable: boolean
  versionMatches: boolean
  errorCode: RemoteMicromambaErrorCode
}> {
  const path = remoteMicromambaPath(root, release)
  const result = await runRemoteMicromambaScript(session, buildVerificationScript(path, root))
  const parsed = parseVerification(result.stdout, result.code)
  const versionMatches = parsed.version === remoteMicromambaBinaryVersion(release)
  const platformMatches =
    !platform || parsed.platform === expectedRemoteMicromambaInfoPlatform(platform)
  const runFailed = versionMatches && platformMatches && !parsed.runSuccessful
  return {
    runnable: parsed.runnable && versionMatches && platformMatches,
    versionMatches,
    errorCode: runFailed ? 'run-verification-failed' : 'verification-failed'
  }
}

async function statusFromScan(
  session: RemoteSshSession,
  root: string,
  options: GetRemoteMicromambaStatusOptions,
  startedAt: number
): Promise<RemoteMicromambaStatusResult> {
  const scanResult = await runRemoteMicromambaScript(session, buildStatusScanScript(root))
  const scan = parseStatusScan(scanResult.stdout)
  const installedVersions = [...new Set([...scan.versions, ...scan.legacyVersions])].sort()
  const base = statusBase(options, startedAt, installedVersions)
  if (scan.state === 'missing') return notInstalledStatus(base, Boolean(options.expectedVersion))
  if (scan.state !== 'ok' || !scan.root) throw new Error('status scan failed')
  if (scan.versions.length === 0) {
    return scan.legacyVersions.length > 0
      ? legacyLayoutStatus(base, options.expectedVersion, scan.legacyVersions)
      : notInstalledStatus(base, Boolean(options.expectedVersion))
  }
  if (options.expectedVersion && !scan.versions.includes(options.expectedVersion)) {
    if (scan.legacyVersions.includes(options.expectedVersion)) {
      return legacyLayoutStatus(base, options.expectedVersion, scan.legacyVersions)
    }
    return {
      ...base,
      status: 'outdated',
      versionMatches: false,
      runnable: null,
      message: '远端 micromamba 版本已过期，需要更新。'
    }
  }
  const selected = options.expectedVersion ?? scan.versions.at(-1) ?? ''
  const verification = await verifyStatusTarget(session, scan.root, selected, options.platform)
  if (!verification.runnable) {
    return {
      ...base,
      status: 'unusable',
      versionMatches: options.expectedVersion ? verification.versionMatches : null,
      runnable: false,
      errorCode: verification.errorCode,
      message: '远端 micromamba 已安装但无法通过运行验证。'
    }
  }
  return {
    ...base,
    status: 'installed',
    versionMatches: options.expectedVersion ? true : null,
    runnable: true,
    message: '远端 micromamba 已安装且可运行。'
  }
}

export async function getRemoteMicromambaStatus(
  session: RemoteSshSession,
  runtimeRoot: string,
  options: GetRemoteMicromambaStatusOptions = {}
): Promise<RemoteMicromambaStatusResult> {
  const startedAt = (options.now ?? Date.now)()
  const empty = statusBase(options, startedAt, [])
  if (!validConfiguredRoot(runtimeRoot)) {
    return failedStatus(empty, '运行时根目录写法无效，无法检查 micromamba 状态。')
  }
  try {
    return await statusFromScan(session, runtimeRoot, options, startedAt)
  } catch {
    return failedStatus(empty, '无法读取远端 micromamba 状态，请检查连接后重试。')
  }
}
