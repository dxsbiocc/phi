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
    message: 'micromamba is not installed on the server.'
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
    message:
      'A legacy R2.2 installation layout was detected and cannot support micromamba run. Reinstall to migrate.'
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
      message: 'Remote micromamba is outdated and needs an update.'
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
      message: 'Remote micromamba is installed but failed runtime verification.'
    }
  }
  return {
    ...base,
    status: 'installed',
    versionMatches: options.expectedVersion ? true : null,
    runnable: true,
    message: 'Remote micromamba is installed and runnable.'
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
    return failedStatus(empty, 'Invalid runtime root path. Unable to check micromamba status.')
  }
  try {
    return await statusFromScan(session, runtimeRoot, options, startedAt)
  } catch {
    return failedStatus(
      empty,
      'Unable to read remote micromamba status. Check the connection and retry.'
    )
  }
}
