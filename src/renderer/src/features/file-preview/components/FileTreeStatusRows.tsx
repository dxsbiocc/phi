import { filePreviewCopy } from '../lib/filePreviewUiCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { Alert, Box, CircularProgress, Typography } from '@mui/material'

export function FileTreeLoadingIndicator({ label }: { label: string }): React.JSX.Element {
  useUiLanguage()
  return (
    <CircularProgress
      size={14}
      thickness={5}
      disableShrink
      aria-label={filePreviewCopy.loadingDirectory(label)}
      sx={{ ml: 'auto', flexShrink: 0 }}
    />
  )
}

export function FileTreeErrorRow({
  path,
  message
}: {
  path: string
  message: string
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Box key={`${path}-error`} sx={{ px: 1.5, py: 0.75 }}>
      <Alert severity="error" variant="outlined">
        {message}
      </Alert>
    </Box>
  )
}

export function FileTreeEmptyRow({
  path,
  depth,
  isEmpty
}: {
  path: string
  depth: number
  isEmpty: boolean
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Typography
      key={`${path}-empty`}
      data-phi-file-tree-empty="true"
      variant="caption"
      color="text.secondary"
      sx={{
        display: 'block',
        px: 1,
        py: 0.75,
        pl: 1 + depth * 1.75 + 2.5
      }}
    >
      {isEmpty ? filePreviewCopy.folderEmpty : filePreviewCopy.noMatchingFiles}
    </Typography>
  )
}

export function FileTreeTruncatedRow({ path }: { path: string }): React.JSX.Element {
  useUiLanguage()
  return (
    <Typography
      key={`${path}-truncated`}
      variant="caption"
      color="text.secondary"
      sx={{ display: 'block', px: 1.5, py: 0.75 }}
    >
      {filePreviewCopy.first400}
    </Typography>
  )
}
