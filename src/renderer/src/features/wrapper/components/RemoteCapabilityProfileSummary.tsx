import { Chip, Stack, Typography } from '@mui/material'
import { GoCpu } from 'react-icons/go'

import type {
  RemoteHostCapability,
  RemoteHostCapabilityProfile
} from '../../../../../shared/remoteDoctorTypes'
import type { RemoteRuntimeRootCapabilityProfile } from '../../../../../shared/remoteRuntimeRootTypes'

const TOOL_LABELS = [
  ['git', 'Git'],
  ['nextflow', 'Nextflow'],
  ['java', 'Java'],
  ['conda', 'Conda'],
  ['sbatch', 'Slurm'],
  ['containerRuntime', '容器运行时'],
  ['module', 'Module']
] as const

const PREREQUISITE_LABELS = [
  ['perl', 'Perl'],
  ['python3', 'Python 3'],
  ['tar', 'tar'],
  ['sha256sum', 'sha256sum']
] as const

const RUNTIME_SOURCE_LABELS = { project: '项目', host: '主机', default: '默认' } as const
const RUNTIME_CHECK_LABELS = {
  pathResolution: '路径',
  creation: '创建',
  ownership: '所有者',
  permissions: '权限',
  filesystem: '文件系统',
  space: '空间',
  executable: '执行',
  sharedFilesystem: '共享盘'
} as const
const RUNTIME_STATE_LABELS = {
  ok: '正常',
  warning: '提醒',
  error: '错误',
  unknown: '未知'
} as const
const RUNTIME_WARNING_LABELS = {
  'not-owned': '不归当前用户所有',
  'group-or-other-writable': '组或其他用户可写',
  symlink: '路径含符号链接',
  'low-space': '剩余空间偏少',
  'high-disk-use': '磁盘使用率较高',
  noexec: '不可执行',
  'shared-filesystem-info': '共享文件系统'
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
  const fallback = capability.state === 'degraded' ? '受限' : '不可用'
  return `${label}：${capability.reason ?? fallback}`
}

function probeWarning(capability: RemoteHostCapability | undefined): string | null {
  if (!capability || capability.state === 'available') return null
  if (
    capability.state === 'degraded' &&
    /tim(?:e|ed)?\s*out|timeout|超时/i.test(capability.reason ?? '')
  ) {
    return '探测：部分检测超时'
  }
  return unavailableTool('探测', capability)
}

function formatSpace(availableSpaceKiB: number | null): string {
  if (availableSpaceKiB === null) return '未知'
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
        unavailableTool('家目录写入', profile.storage.homeWritable),
        unavailableTool('执行落点', profile.storage.homeExecutable),
        unavailableTool(
          '可用空间',
          profile.storage.availableSpace ??
            (profile.storage.availableSpaceKiB === null
              ? { state: 'unavailable', reason: '无法确定可用空间' }
              : { state: 'available' })
        ),
        unavailableTool('共享文件系统', profile.storage.sharedFileSystem)
      ].filter((warning): warning is string => Boolean(warning))
    : []
  const probeStatus = probeWarning(profile.probe)
  return {
    detail: profile.storage ? `可用空间：${formatSpace(profile.storage.availableSpaceKiB)}` : null,
    warnings: [...(probeStatus ? [probeStatus] : []), ...prerequisiteWarnings, ...storageWarnings]
  }
}

function toolSummaries(profile: RemoteHostCapabilityProfile): {
  available: string[]
  unavailable: string[]
} {
  return TOOL_LABELS.reduce<{ available: string[]; unavailable: string[] }>(
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
        (compatibility.state === 'degraded' ? 'helper 受限' : 'helper 不可用'))
      : null
  if (unavailable.length === 0 && !compatibilityReason) return null
  const reasons = [
    ...new Set(
      [compatibilityReason, ...unavailable.map((capability) => capability.reason)].filter(Boolean)
    )
  ]
  return `辅助能力：${reasons.join('；') || '部分不可用'}`
}

function runtimeRootStatus(profile: RemoteRuntimeRootCapabilityProfile): string {
  if (profile.status === 'timed-out') return '检测超时'
  if (profile.status === 'failed' || profile.status === 'incomplete') return '未完成'
  if (profile.hasHardError) return '有硬性错误'
  if (profile.warningCodes.length > 0) return '有提醒'
  return '已检查'
}

function RuntimeRootSummary({
  profile
}: {
  profile?: RemoteRuntimeRootCapabilityProfile
}): React.JSX.Element {
  if (!profile) {
    return <Typography variant="caption">运行时根目录：未检查</Typography>
  }
  const checks = Object.entries(profile.checks)
    .map(
      ([key, state]) =>
        `${RUNTIME_CHECK_LABELS[key as keyof typeof RUNTIME_CHECK_LABELS]} ${RUNTIME_STATE_LABELS[state]}`
    )
    .join('、')
  return (
    <Stack spacing={0.25}>
      <Typography variant="caption">
        运行时根目录：来自{RUNTIME_SOURCE_LABELS[profile.source]} · {runtimeRootStatus(profile)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        检查：{checks}
      </Typography>
      {profile.warningCodes.length > 0 && (
        <Typography variant="caption" color="warning.main">
          告警：
          {profile.warningCodes.map((code) => RUNTIME_WARNING_LABELS[code]).join('、')}
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
  const tools = toolSummaries(profile)
  const helper = helperSummary(profile)
  const environment = environmentSummary(profile)
  const probedAt = new Date(profile.probedAt)
  return (
    <Stack spacing={0.75}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <GoCpu size={17} aria-hidden="true" />
        <Typography variant="subtitle2">服务器能力档案</Typography>
        <Chip size="small" variant="outlined" label={platformLabel(profile)} />
      </Stack>
      <Typography variant="caption" color="text.secondary">
        可用工具：{tools.available.join('、') || '未发现'}
      </Typography>
      {tools.unavailable.length > 0 && (
        <Typography variant="caption" color="warning.main">
          {tools.unavailable.join('；')}
        </Typography>
      )}
      {environment.detail && (
        <Typography variant="caption" color="text.secondary">
          {environment.detail}
        </Typography>
      )}
      {environment.warnings.length > 0 && (
        <Typography variant="caption" color="warning.main">
          环境限制：{environment.warnings.join('；')}
        </Typography>
      )}
      <RuntimeRootSummary profile={profile.runtimeRoot} />
      {helper && (
        <Typography variant="caption" color="text.secondary">
          {helper}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary">
        档案更新：
        {Number.isNaN(probedAt.getTime()) ? profile.probedAt : probedAt.toLocaleString()}
      </Typography>
    </Stack>
  )
}
