import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Typography
} from '@mui/material'

import type { RemoteDoctorStatus } from '../../../../../shared/remoteDoctorTypes'
import type { RemoteDoctorUiState } from '../lib/remoteDoctorUi'

const CHECK_LABELS: Record<string, string> = {
  ssh: 'SSH 连接',
  sftp: '文件上传工具',
  path: '远端目录',
  path_read: '目录读取权限',
  path_write: '目录写入权限',
  shell: '登录 shell',
  nextflow: 'Nextflow',
  java: 'Java',
  slurm_submit: 'Slurm 提交',
  slurm_status: 'Slurm 状态',
  slurm_detail: 'Slurm 详情',
  slurm_cancel: 'Slurm 取消',
  runtime: '容器或 Conda 运行时'
}

const STATUS_LABELS: Record<RemoteDoctorStatus, string> = {
  ok: '正常',
  warning: '提醒',
  error: '需处理'
}

const STATUS_COLORS: Record<RemoteDoctorStatus, 'success' | 'warning' | 'error'> = {
  ok: 'success',
  warning: 'warning',
  error: 'error'
}

export function RemoteDoctorPanel({
  state,
  targetKey
}: {
  state: RemoteDoctorUiState
  targetKey: string
}): React.JSX.Element | null {
  if (state.phase === 'idle' || state.key !== targetKey) return null
  if (state.phase === 'running') {
    return (
      <Alert severity="info" icon={<CircularProgress size={18} />} sx={{ mt: 1.5 }}>
        正在检查服务器、远端目录和运行环境…
      </Alert>
    )
  }
  if (state.phase === 'failed') {
    return (
      <Alert severity="error" sx={{ mt: 1.5 }}>
        {state.message}
      </Alert>
    )
  }

  const { report } = state
  const sshOk = report.checks.some((check) => check.id === 'ssh' && check.status === 'ok')
  const hasWarning = report.checks.some((check) => check.status === 'warning')
  const summary = !sshOk
    ? '无法建立 SSH 连接'
    : !report.ok
      ? 'SSH 已连接，部分检查仍需处理'
      : hasWarning
        ? '检查完成，存在提醒'
        : '检查通过'
  const checkedAt = new Date(report.checkedAt)

  return (
    <Paper variant="outlined" sx={{ mt: 1.5, p: 1.5, bgcolor: 'background.default' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {summary}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          检查时间：
          {Number.isNaN(checkedAt.getTime()) ? report.checkedAt : checkedAt.toLocaleString()}
        </Typography>
      </Stack>
      <Divider sx={{ my: 1 }} />
      <Stack spacing={1.25}>
        {report.checks.map((check) => (
          <Box key={check.id}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Chip
                size="small"
                variant="outlined"
                color={STATUS_COLORS[check.status]}
                label={STATUS_LABELS[check.status]}
              />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {CHECK_LABELS[check.id] ?? check.id}：{check.message}
              </Typography>
            </Stack>
            {check.suggestion && (
              <Typography variant="caption" color="text.secondary" sx={{ ml: 6, display: 'block' }}>
                {check.suggestion}
              </Typography>
            )}
          </Box>
        ))}
      </Stack>
    </Paper>
  )
}
