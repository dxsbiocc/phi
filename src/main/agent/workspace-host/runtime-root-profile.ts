import type {
  RemoteMicromambaCapabilityProfile,
  RemoteMicromambaProfileStatus,
  RemoteRuntimeRootCapabilityProfile,
  RemoteRuntimeRootCheckResult,
  RemoteRuntimeRootProfileCheckState,
  RemoteRuntimeRootSource,
  RemoteRuntimeRootWarningCode
} from '../../../shared/remoteRuntimeRootTypes'
import type { HostCapabilityProfile } from './types'

const MICROMAMBA_PROFILE_STATUSES = new Set([
  'unchecked',
  'not-installed',
  'installed',
  'outdated',
  'unusable'
])
const MICROMAMBA_VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/

function isMicromambaProfileStatus(value: unknown): value is RemoteMicromambaProfileStatus {
  return typeof value === 'string' && MICROMAMBA_PROFILE_STATUSES.has(value)
}

export interface RemoteMicromambaProfileInput {
  checked: boolean
  installedVersion: string | null
  expectedVersion: string
  runnable: boolean
}

export function remoteMicromambaCapabilityProfile(
  input: RemoteMicromambaProfileInput
): RemoteMicromambaCapabilityProfile {
  if (!input.checked) return { status: 'unchecked' }
  if (input.installedVersion === null) return { status: 'not-installed' }
  if (!input.runnable) return { status: 'unusable', version: input.installedVersion }
  if (input.installedVersion !== input.expectedVersion) {
    return { status: 'outdated', version: input.installedVersion }
  }
  return { status: 'installed', version: input.installedVersion }
}

export function normalizeRemoteMicromambaCapabilityProfile(
  value: unknown
): RemoteMicromambaCapabilityProfile {
  if (typeof value !== 'object' || value === null) return { status: 'unchecked' }
  const candidate = value as { status?: unknown; version?: unknown }
  if (!isMicromambaProfileStatus(candidate.status)) return { status: 'unchecked' }
  if (candidate.status === 'unchecked' || candidate.status === 'not-installed') {
    return { status: candidate.status }
  }
  if (
    typeof candidate.version !== 'string' ||
    !MICROMAMBA_VERSION_PATTERN.test(candidate.version)
  ) {
    return { status: 'unchecked' }
  }
  return { status: candidate.status, version: candidate.version }
}

export function withRemoteMicromambaCapabilityProfile<T extends HostCapabilityProfile>(
  profile: T,
  value: unknown
): T {
  if (!profile.runtimeRoot) return profile
  const runtimeRoot = profile.runtimeRoot
  return {
    ...profile,
    runtimeRoot: {
      source: runtimeRoot.source,
      checkedAt: runtimeRoot.checkedAt,
      status: runtimeRoot.status,
      hasHardError: runtimeRoot.hasHardError,
      warningCodes: runtimeRoot.warningCodes,
      micromamba: normalizeRemoteMicromambaCapabilityProfile(value),
      checks: {
        pathResolution: runtimeRoot.checks.pathResolution,
        creation: runtimeRoot.checks.creation,
        ownership: runtimeRoot.checks.ownership,
        permissions: runtimeRoot.checks.permissions,
        filesystem: runtimeRoot.checks.filesystem,
        space: runtimeRoot.checks.space,
        executable: runtimeRoot.checks.executable,
        sharedFilesystem: runtimeRoot.checks.sharedFilesystem
      }
    }
  }
}

export function withExpectedRemoteMicromambaVersion<T extends HostCapabilityProfile>(
  profile: T,
  expectedVersion: string
): T {
  const micromamba = profile.runtimeRoot?.micromamba
  if (!micromamba || (micromamba.status !== 'installed' && micromamba.status !== 'outdated')) {
    return profile
  }
  return withRemoteMicromambaCapabilityProfile(profile, {
    status: micromamba.version === expectedVersion ? 'installed' : 'outdated',
    version: micromamba.version
  })
}

function flagState(
  value: boolean | null,
  warningWhen: boolean
): RemoteRuntimeRootProfileCheckState {
  if (value === null) return 'unknown'
  return value === warningWhen ? 'warning' : 'ok'
}

function pathState(result: RemoteRuntimeRootCheckResult): RemoteRuntimeRootProfileCheckState {
  if (
    result.hardErrors.some(
      (error) => error.code === 'invalid-configured-root' || error.code === 'unable-to-expand'
    )
  ) {
    return 'error'
  }
  return result.expandedPath ? 'ok' : 'unknown'
}

function creationState(result: RemoteRuntimeRootCheckResult): RemoteRuntimeRootProfileCheckState {
  if (result.hardErrors.length > 0) return 'error'
  if (result.exists === true || result.ancestorWritable === true) return 'ok'
  return 'unknown'
}

function knownState(value: unknown): RemoteRuntimeRootProfileCheckState {
  return value === null || value === undefined ? 'unknown' : 'ok'
}

function warningState(
  known: boolean,
  codes: ReadonlySet<RemoteRuntimeRootWarningCode>,
  warnings: readonly RemoteRuntimeRootWarningCode[]
): RemoteRuntimeRootProfileCheckState {
  if (warnings.some((code) => codes.has(code))) return 'warning'
  return known ? 'ok' : 'unknown'
}

export function runtimeRootCapabilityProfile(
  source: RemoteRuntimeRootSource,
  result: RemoteRuntimeRootCheckResult,
  previousMicromamba: RemoteMicromambaCapabilityProfile = { status: 'unchecked' }
): RemoteRuntimeRootCapabilityProfile {
  const warningCodes = [...new Set(result.warnings.map((warning) => warning.code))]
  const codes = new Set(warningCodes)
  return {
    source,
    checkedAt: result.checkedAt,
    status: result.status,
    hasHardError: result.hardErrors.length > 0,
    warningCodes,
    micromamba: normalizeRemoteMicromambaCapabilityProfile(previousMicromamba),
    checks: {
      pathResolution: pathState(result),
      creation: creationState(result),
      ownership: flagState(result.ownedByCurrentUser, false),
      permissions: flagState(result.groupOrOtherWritable, true),
      filesystem: knownState(result.fsType),
      space: warningState(result.availableKiB !== null, codes, ['low-space', 'high-disk-use']),
      executable: flagState(result.executable, false),
      sharedFilesystem: warningState(result.sharedFilesystem !== null, codes, [
        'shared-filesystem-info'
      ])
    }
  }
}
