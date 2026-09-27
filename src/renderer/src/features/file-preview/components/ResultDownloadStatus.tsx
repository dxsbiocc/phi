import { Alert, Box, Button, LinearProgress, Typography } from '@mui/material'

import { formatBytes } from '../../../lib/toolOutputPresentation'
import type { FileDownloadState } from '../lib/filePreviewState'

export function ResultDownloadStatus({
  state,
  onCancel
}: {
  state: FileDownloadState | null | undefined
  onCancel?: () => void
}): React.JSX.Element | null {
  if (!state) return null
  if (state.status === 'saved') {
    return (
      <Alert severity="success" sx={{ mx: 1.5, mt: 1 }}>
        已保存 {formatBytes(state.bytes)} 到 {state.path}
        {state.remoteDigestVerified === false ? '；服务器未提供摘要，已核对文件大小' : ''}
      </Alert>
    )
  }
  if (state.status === 'error') {
    return (
      <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
        {state.message}
      </Alert>
    )
  }
  const encodedName = state.sourcePath.split('/').at(-1) ?? '文件'
  let fileName = encodedName
  try {
    fileName = decodeURIComponent(encodedName)
  } catch {
    // The remote URI remains available even if a filename cannot be decoded for display.
  }
  const label =
    state.phase === 'choosing'
      ? '请选择本地保存位置'
      : state.phase === 'verifying'
        ? '正在校验下载文件'
        : state.phase === 'saving'
          ? '正在保存文件'
          : `正在下载 ${fileName}：${formatBytes(state.bytesDownloaded)} / ${formatBytes(state.totalBytes)}`
  const percent =
    state.totalBytes > 0
      ? Math.min(100, Math.round((state.bytesDownloaded / state.totalBytes) * 100))
      : undefined
  return (
    <Box sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Typography variant="caption" sx={{ flex: 1 }}>
          {label}
        </Typography>
        <Button
          size="small"
          disabled={!onCancel || state.phase === 'choosing' || state.phase === 'saving'}
          onClick={onCancel}
        >
          取消下载
        </Button>
      </Box>
      <LinearProgress
        variant={percent === undefined ? 'indeterminate' : 'determinate'}
        value={percent}
        aria-label="下载进度"
      />
    </Box>
  )
}
