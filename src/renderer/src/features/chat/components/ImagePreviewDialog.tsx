import { Box, Dialog, IconButton, Typography } from '@mui/material'

import { PhiIcons } from '../../../icons'

const CloseIcon = PhiIcons.action.close

export function ImagePreviewDialog({
  source,
  alt,
  onClose
}: {
  source: string | null
  alt: string
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog
      open={source !== null}
      onClose={onClose}
      maxWidth={false}
      aria-label="图片预览"
      slotProps={{
        paper: {
          sx: { width: 'min(96vw, 1400px)', maxHeight: '94vh', m: 1 }
        }
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2,
          py: 1
        }}
      >
        <Typography variant="subtitle1">图片预览</Typography>
        <IconButton type="button" aria-label="关闭图片预览" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      <Box
        sx={{
          minHeight: 0,
          maxHeight: 'calc(94vh - 56px)',
          overflow: 'auto',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          p: 2,
          bgcolor: 'background.default'
        }}
      >
        {source && (
          <Box
            component="img"
            src={source}
            alt={alt}
            sx={{
              display: 'block',
              maxWidth: '100%',
              maxHeight: 'calc(94vh - 88px)',
              objectFit: 'contain'
            }}
          />
        )}
      </Box>
    </Dialog>
  )
}
