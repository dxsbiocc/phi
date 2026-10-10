import { posix } from 'node:path'

import type {
  RemoteMicromambaPlatform,
  RemoteMicromambaStatusResult
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

async function verifyStatusTarget(
  session: RemoteSshSession,
  root: string,
  release: string,
  platform: RemoteMicromambaPlatform | undefined
): Promise<{ runnable: boolean; versionMatches: boolean }> {
  const path = posix.join(root, 'bin', `micromamba-${release}`)
  const result = await runRemoteMicromambaScript(session, buildVerificationScript(path, root))
  const parsed = parseVerification(result.stdout, result.code)
  const versionMatches = parsed.version === remoteMicromambaBinaryVersion(release)
  const platformMatches =
    !platform || parsed.platform === expectedRemoteMicromambaInfoPlatform(platform)
  return { runnable: parsed.runnable && versionMatches && platformMatches, versionMatches }
}

async function statusFromScan(
  session: RemoteSshSession,
  root: string,
  options: GetRemoteMicromambaStatusOptions,
  startedAt: number
): Promise<RemoteMicromambaStatusResult> {
  const scanResult = await runRemoteMicromambaScript(session, buildStatusScanScript(root))
  const scan = parseStatusScan(scanResult.stdout)
  const base = statusBase(options, startedAt, scan.versions)
  if (scan.state === 'missing') return notInstalledStatus(base, Boolean(options.expectedVersion))
  if (scan.state !== 'ok' || !scan.root) throw new Error('status scan failed')
  if (scan.versions.length === 0) return notInstalledStatus(base, Boolean(options.expectedVersion))
  if (options.expectedVersion && !scan.versions.includes(options.expectedVersion)) {
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
      errorCode: 'verification-failed',
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
