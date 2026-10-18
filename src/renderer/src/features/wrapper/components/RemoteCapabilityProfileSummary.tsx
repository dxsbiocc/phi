import { getUiLocale, useUiLanguage } from '../../../lib/i18n'
import { remoteSetupCopy } from '../lib/remoteSetupCopy'
import { Chip, Stack, Typography } from '@mui/material'
import { GoCpu } from 'react-icons/go'

import type {
  RemoteHostCapability,
  RemoteHostCapabilityProfile
} from '../../../../../shared/remoteDoctorTypes'
import type { RemoteRuntimeRootCapabilityProfile } from '../../../../../shared/remoteRuntimeRootTypes'

const toolLabels = () =>
  [
    ['git', 'Git'],
    ['nextflow', 'Nextflow'],
    ['java', 'Java'],
    ['conda', 'Conda'],
    ['sbatch', 'Slurm'],
    ['containerRuntime', remoteSetupCopy.containerRuntime],
    ['module', 'Module']
  ] as const

const PREREQUISITE_LABELS = [
  ['perl', 'Perl'],
  ['python3', 'Python 3'],
  ['tar', 'tar'],
  ['sha256sum', 'sha256sum']
] as const

const RUNTIME_SOURCE_LABELS = {
  get project() {
    return remoteSetupCopy.project
  },
  get host() {
    return remoteSetupCopy.host
  },
  get default() {
    return remoteSetupCopy.default
  }
} as const
const RUNTIME_CHECK_LABELS = {
  get pathResolution() {
    return remoteSetupCopy.path
  },
  get creation() {
    return remoteSetupCopy.creation
  },
  get ownership() {
    return remoteSetupCopy.ownership
  },
  get permissions() {
    return remoteSetupCopy.permissions
  },
  get filesystem() {
    return remoteSetupCopy.filesystem
  },
  get space() {
    return remoteSetupCopy.space
  },
  get executable() {
    return remoteSetupCopy.execution
  },
  get sharedFilesystem() {
    return remoteSetupCopy.sharedStorage
  }
} as const
const RUNTIME_STATE_LABELS = {
  get ok() {
    return remoteSetupCopy.ok
  },
  get warning() {
    return remoteSetupCopy.warning
  },
  get error() {
    return remoteSetupCopy.error
  },
  get unknown() {
    return remoteSetupCopy.unknown
  }
} as const
const RUNTIME_WARNING_LABELS = {
  get 'not-owned'() {
    return remoteSetupCopy.notOwned
  },
  get 'group-or-other-writable'() {
    return remoteSetupCopy.groupWritable
  },
  get symlink() {
    return remoteSetupCopy.containsSymlink
  },
  get 'low-space'() {
    return remoteSetupCopy.lowSpace
  },
  get 'high-disk-use'() {
    return remoteSetupCopy.highDiskUse
  },
  get noexec() {
    return remoteSetupCopy.notExecutable
  },
  get 'shared-filesystem-info'() {
    return remoteSetupCopy.sharedFilesystem
  }
} as const

function platformLabel(profile: RemoteHostCapabilityProfile): string {
  const os =
    profile.platform.os.toLowerCase() === 'linux'
      ? 'Linux'
      : profile.platform.os.toLowerCase() === 'darwin'
        ? 'macOS'
        : profile.platform.os
  const libc = profile.platform.libc
  const libcLabel = libc ? ` · ${libc.name}${libc.version ? ` ${libc.version}` : ''}` : ''
  return `${os} · ${profile.platform.arch}${libcLabel}`
}

function availableTool(label: string, capability: RemoteHostCapability): string | null {
  if (capability.state !== 'available') return null
  return `${label}${capability.version ? ` ${capability.version}` : ''}`
}

function unavailableTool(label: string, capability: RemoteHostCapability): string | null {
  if (capability.state === 'available') return null
  const fallback =
    capability.state === 'degraded' ? remoteSetupCopy.limited : remoteSetupCopy.unavailable
  return `${label}: ${capability.reason ?? fallback}`
}

function probeWarning(capability: RemoteHostCapability | undefined): string | null {
  if (!capability || capability.state === 'available') return null
  if (
    capability.state === 'degraded' &&
    /tim(?:e|ed)?\s*out|timeout|超时/i.test(capability.reason ?? '')
  ) {
    return remoteSetupCopy.probeTimedOut
  }
  return unavailableTool(remoteSetupCopy.probe, capability)
}

function formatSpace(availableSpaceKiB: number | null): string {
  if (availableSpaceKiB === null) return remoteSetupCopy.unknown
  const gibibytes = availableSpaceKiB / 1024 / 1024
  return `${Number.isInteger(gibibytes) ? gibibytes : gibibytes.toFixed(1)} GiB`
}

function environmentSummary(profile: RemoteHostCapabilityProfile): {
  detail: string | null
  warnings: string[]
} {
  const prerequisiteWarnings = profile.prerequisites
    ? PREREQUISITE_LABELS.map(([key, label]) =>
        unavailableTool(label, profile.prerequisites?.[key] ?? { state: 'unavailable' })
      ).filter((warning): warning is string => Boolean(warning))
    : []
  const storageWarnings = profile.storage
    ? [
        unavailableTool(remoteSetupCopy.homeWritable, profile.storage.homeWritable),
        unavailableTool(remoteSetupCopy.executionDirectory, profile.storage.homeExecutable),
        unavailableTool(
          remoteSetupCopy.availableSpace,
          profile.storage.availableSpace ??
            (profile.storage.availableSpaceKiB === null
              ? {
                  state: 'unavailable',
                  get reason() {
                    return remoteSetupCopy.unknownAvailableSpace
                  }
                }
              : { state: 'available' })
        ),
        unavailableTool(remoteSetupCopy.sharedFilesystem, profile.storage.sharedFileSystem)
      ].filter((warning): warning is string => Boolean(warning))
    : []
  const probeStatus = probeWarning(profile.probe)
  return {
    detail: profile.storage
      ? remoteSetupCopy.availableSpaceValue(formatSpace(profile.storage.availableSpaceKiB))
      : null,
    warnings: [...(probeStatus ? [probeStatus] : []), ...prerequisiteWarnings, ...storageWarnings]
  }
}

function toolSummaries(profile: RemoteHostCapabilityProfile): {
  available: string[]
  unavailable: string[]
} {
  return toolLabels().reduce<{ available: string[]; unavailable: string[] }>(
    (summary, [key, label]) => {
      const capability = profile.toolchain[key]
      const available = availableTool(label, capability)
      const unavailable = unavailableTool(label, capability)
      return {
        available: available ? [...summary.available, available] : summary.available,
        unavailable: unavailable ? [...summary.unavailable, unavailable] : summary.unavailable
      }
    },
    { available: [], unavailable: [] }
  )
}

function helperSummary(profile: RemoteHostCapabilityProfile): string | null {
  const unavailable = [profile.pty, profile.watch, profile.forwardPort].filter(
    (capability) => capability.state !== 'available'
  )
  const compatibility = profile.helperCompatibility
  const compatibilityReason =
    compatibility && compatibility.state !== 'available'
      ? (compatibility.reason ??
        (compatibility.state === 'degraded'
          ? remoteSetupCopy.helperLimited
          : remoteSetupCopy.helperUnavailable))
      : null
  if (unavailable.length === 0 && !compatibilityReason) return null
  const reasons = [
    ...new Set(
      [compatibilityReason, ...unavailable.map((capability) => capability.reason)].filter(
        (reason): reason is string => Boolean(reason)
      )
    )
  ]
  return remoteSetupCopy.auxiliaryCapabilities(reasons)
}

function runtimeRootStatus(profile: RemoteRuntimeRootCapabilityProfile): string {
  if (profile.status === 'timed-out') return remoteSetupCopy.checkTimedOut
  if (profile.status === 'failed' || profile.status === 'incomplete')
    return remoteSetupCopy.incomplete
  if (profile.hasHardError) return remoteSetupCopy.hasHardErrors
  if (profile.warningCodes.length > 0) return remoteSetupCopy.hasWarnings
  return remoteSetupCopy.checked
}

function RuntimeRootSummary({
  profile
}: {
  profile?: RemoteRuntimeRootCapabilityProfile
}): React.JSX.Element {
  useUiLanguage()
  if (!profile) {
    return <Typography variant="caption">{remoteSetupCopy.runtimeRootUnchecked}</Typography>
  }
  const checks = Object.entries(profile.checks)
    .map(
      ([key, state]) =>
        `${RUNTIME_CHECK_LABELS[key as keyof typeof RUNTIME_CHECK_LABELS]} ${RUNTIME_STATE_LABELS[state]}`
    )
    .join(', ')
  return (
    <Stack spacing={0.25}>
      <Typography variant="caption">
        {remoteSetupCopy.runtimeRootSource}
        {RUNTIME_SOURCE_LABELS[profile.source]} · {runtimeRootStatus(profile)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {remoteSetupCopy.checksPrefix}
        {checks}
      </Typography>
      {profile.warningCodes.length > 0 && (
        <Typography variant="caption" color="warning.main">
          {remoteSetupCopy.warningsPrefix}
          {profile.warningCodes.map((code) => RUNTIME_WARNING_LABELS[code]).join(', ')}
        </Typography>
      )}
    </Stack>
  )
}

export function RemoteCapabilityProfileSummary({
  profile
}: {
  profile: RemoteHostCapabilityProfile
}): React.JSX.Element {
  useUiLanguage()
  const tools = toolSummaries(profile)
  const helper = helperSummary(profile)
  const environment = environmentSummary(profile)
  const probedAt = new Date(profile.probedAt)
  return (
    <Stack spacing={0.75}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <GoCpu size={17} aria-hidden="true" />
        <Typography variant="subtitle2">{remoteSetupCopy.capabilityProfile}</Typography>
        <Chip size="small" variant="outlined" label={platformLabel(profile)} />
      </Stack>
      <Typography variant="caption" color="text.secondary">
        {remoteSetupCopy.availableToolsPrefix}
        {tools.available.join(', ') || remoteSetupCopy.noneFound}
      </Typography>
      {tools.unavailable.length > 0 && (
        <Typography variant="caption" color="warning.main">
          {tools.unavailable.join('; ')}
        </Typography>
      )}
      {environment.detail && (
        <Typography variant="caption" color="text.secondary">
          {environment.detail}
        </Typography>
      )}
      {environment.warnings.length > 0 && (
        <Typography variant="caption" color="warning.main">
          {remoteSetupCopy.environmentLimitationsPrefix}
          {environment.warnings.join('; ')}
        </Typography>
      )}
      <RuntimeRootSummary profile={profile.runtimeRoot} />
      {helper && (
        <Typography variant="caption" color="text.secondary">
          {helper}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary">
        {remoteSetupCopy.profileUpdatedPrefix}
        {Number.isNaN(probedAt.getTime())
          ? profile.probedAt
          : probedAt.toLocaleString(getUiLocale())}
      </Typography>
    </Stack>
  )
}
