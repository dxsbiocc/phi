import { filePreviewCopy } from '../lib/filePreviewUiCopy'
import { useUiLanguage } from '../../../lib/i18n'
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
  useUiLanguage()
  if (!state) return null
  if (state.status === 'saved') {
    return (
      <Alert severity="success" sx={{ mx: 1.5, mt: 1 }}>
        {filePreviewCopy.savedDownload(formatBytes(state.bytes), state.path)}
        {state.remoteDigestVerified === false ? filePreviewCopy.missingDigest : ''}
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
  const encodedName = state.sourcePath.split('/').at(-1) ?? filePreviewCopy.file
  let fileName = encodedName
  try {
    fileName = decodeURIComponent(encodedName)
  } catch {
    // The remote URI remains available even if a filename cannot be decoded for display.
  }
  const label =
    state.phase === 'choosing'
      ? filePreviewCopy.chooseSaveLocation
      : state.phase === 'verifying'
        ? filePreviewCopy.verifyingDownload
        : state.phase === 'saving'
          ? filePreviewCopy.savingFile
          : filePreviewCopy.downloading(
              fileName,
              formatBytes(state.bytesDownloaded),
              formatBytes(state.totalBytes)
            )
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
          {filePreviewCopy.cancelDownload}
        </Button>
      </Box>
      <LinearProgress
        variant={percent === undefined ? 'indeterminate' : 'determinate'}
        value={percent}
        aria-label={filePreviewCopy.downloadProgress}
      />
    </Box>
  )
}
