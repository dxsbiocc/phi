import { Alert, Button, LinearProgress, Stack, Typography } from '@mui/material'

import type { RemoteHostCapabilityProfile } from '../../../../../shared/remoteDoctorTypes'
import type {
  RemoteMicromambaCapabilityProfile,
  RemoteRuntimeRootWarningCode
} from '../../../../../shared/remoteRuntimeRootTypes'
import type { RemoteMicromambaResult } from '../../../../../shared/remoteMicromambaTypes'

const MICROMAMBA_VERSION = '2.9.0-0'
const REMOTE_ARTIFACT_SIZES: Readonly<Record<string, number>> = {
  x86_64: 18_292_808,
  x64: 18_292_808,
  aarch64: 22_020_296,
  arm64: 22_020_296
}

interface RemoteMicromambaProgressView {
  requestId: string
  stage: string
  transferredBytes?: number
  totalBytes?: number
  message: string
}

export type RemoteMicromambaUiState =
  | { phase: 'idle' }
  | { phase: 'running'; progress?: RemoteMicromambaProgressView }
  | { phase: 'done'; result: RemoteMicromambaResult }

export interface RemoteMicromambaControlProps {
  capabilityProfile?: RemoteHostCapabilityProfile
  runtimeRoot: string
  state: RemoteMicromambaUiState
  disabled?: boolean
  onInstall: (confirmedWarnings?: readonly RemoteRuntimeRootWarningCode[]) => void
}

function formatBytes(bytes: number | undefined): string {
  return bytes === undefined ? '服务器架构检测后确定' : `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function micromambaStatus(
  profile: RemoteHostCapabilityProfile | undefined,
  state: RemoteMicromambaUiState
): RemoteMicromambaCapabilityProfile {
  if (
    state.phase === 'done' &&
    (state.result.status === 'installed' || state.result.status === 'already-installed')
  ) {
    return { status: 'installed', version: state.result.version }
  }
  if (state.phase === 'done' && state.result.errorCode === 'verification-failed') {
    return { status: 'unusable', version: state.result.version }
  }
  return profile?.runtimeRoot?.micromamba ?? { status: 'unchecked' }
}

function statusLabel(status: RemoteMicromambaCapabilityProfile): string {
  const version = 'version' in status ? `（${status.version}）` : ''
  const labels = {
    unchecked: '未检查',
    'not-installed': '未安装',
    installed: `已安装${version}`,
    outdated: `版本过期${version}`,
    unusable: `不可运行${version}`
  }
  return labels[status.status]
}

function targetPath(root: string): string {
  return `${root.replace(/\/+$/, '')}/bin/micromamba-${MICROMAMBA_VERSION}`
}

function progressPercent(progress: RemoteMicromambaProgressView | undefined): number | undefined {
  if (!progress?.totalBytes || progress.transferredBytes === undefined) return undefined
  return Math.min(100, Math.round((progress.transferredBytes / progress.totalBytes) * 100))
}

function Progress({ progress }: { progress?: RemoteMicromambaProgressView }): React.JSX.Element {
  const percent = progressPercent(progress)
  return (
    <Stack spacing={0.5}>
      <Typography variant="caption">{progress?.message ?? '正在准备 micromamba…'}</Typography>
      <LinearProgress
        variant={percent === undefined ? 'indeterminate' : 'determinate'}
        value={percent}
      />
      {percent !== undefined && <Typography variant="caption">{percent}%</Typography>}
    </Stack>
  )
}

function Result({ result }: { result: RemoteMicromambaResult }): React.JSX.Element {
  const severity =
    result.status === 'failed' || result.status === 'unsupported'
      ? 'error'
      : result.status === 'needs-confirmation'
        ? 'warning'
        : 'success'
  return <Alert severity={severity}>{result.message}</Alert>
}

export function RemoteMicromambaControl({
  capabilityProfile,
  runtimeRoot,
  state,
  disabled,
  onInstall
}: RemoteMicromambaControlProps): React.JSX.Element {
  const size = REMOTE_ARTIFACT_SIZES[capabilityProfile?.platform.arch ?? '']
  const needsConfirmation =
    state.phase === 'done' && state.result.status === 'needs-confirmation'
      ? state.result.warningCodes
      : undefined
  return (
    <Stack spacing={0.75}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        micromamba：{statusLabel(micromambaStatus(capabilityProfile, state))}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        将从桌面端上传 {formatBytes(size)} 至 {targetPath(runtimeRoot)}；服务器不会联网下载。
      </Typography>
      <Button
        size="small"
        variant="outlined"
        disabled={disabled || state.phase === 'running'}
        onClick={() => onInstall(needsConfirmation)}
        sx={{ alignSelf: 'flex-start' }}
      >
        {needsConfirmation ? '仍然使用' : '安装/更新 micromamba'}
      </Button>
      {state.phase === 'running' && <Progress progress={state.progress} />}
      {state.phase === 'done' && <Result result={state.result} />}
    </Stack>
  )
}
