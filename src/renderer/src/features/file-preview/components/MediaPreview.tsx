import { Box } from '@mui/material'
import type { FilePreview } from '../../../types'

export function MediaPreview({
  file
}: {
  file: Extract<FilePreview, { kind: 'image' | 'pdf' }>
}): React.JSX.Element {
  if (file.kind === 'image') {
    return (
      <Box
        data-phi-media-preview="image"
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: 'auto',
          p: 2,
          bgcolor: 'background.default',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <Box
          component="img"
          src={file.dataUrl}
          alt={file.name}
          sx={{
            display: 'block',
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            borderRadius: 1,
            boxShadow: (theme) => `0 0 0 1px ${theme.palette.divider}`
          }}
        />
      </Box>
    )
  }

  return (
    <Box
      data-phi-media-preview="pdf"
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        bgcolor: 'background.default',
        display: 'flex'
      }}
    >
      <Box
        component="iframe"
        src={file.dataUrl}
        title={file.name}
        aria-label={`PDF 预览：${file.name}`}
        sx={{
          flex: 1,
          width: '100%',
          height: '100%',
          border: 0,
          bgcolor: 'background.default'
        }}
      />
    </Box>
  )
}
