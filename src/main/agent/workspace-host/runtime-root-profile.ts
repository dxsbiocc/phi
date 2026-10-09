import type {
  RemoteRuntimeRootCapabilityProfile,
  RemoteRuntimeRootCheckResult,
  RemoteRuntimeRootProfileCheckState,
  RemoteRuntimeRootSource,
  RemoteRuntimeRootWarningCode
} from '../../../shared/remoteRuntimeRootTypes'

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
  result: RemoteRuntimeRootCheckResult
): RemoteRuntimeRootCapabilityProfile {
  const warningCodes = [...new Set(result.warnings.map((warning) => warning.code))]
  const codes = new Set(warningCodes)
  return {
    source,
    checkedAt: result.checkedAt,
    status: result.status,
    hasHardError: result.hardErrors.length > 0,
    warningCodes,
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
