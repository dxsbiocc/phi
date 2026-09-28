import { Box, IconButton, Stack, Typography } from '@mui/material'
import { useState } from 'react'

import type { PromptImageInput } from '../../../../../shared/promptImageTypes'
import { PhiIcons } from '../../../icons'
import { ImagePreviewDialog } from './ImagePreviewDialog'

const CloseIcon = PhiIcons.action.close

export function PastedImagePreview({
  images,
  error,
  onRemove
}: {
  images: PromptImageInput[]
  error: string | null
  onRemove?: (index: number) => void
}): React.JSX.Element | null {
  const [preview, setPreview] = useState<{ source: string; alt: string } | null>(null)
  if (images.length === 0 && !error) return null
  return (
    <>
      {images.length > 0 && (
        <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }} aria-label="待发送图片">
          {images.map((image, index) => (
            <Box key={`${image.mimeType}-${index}`} sx={{ position: 'relative' }}>
              <Box
                component="button"
                type="button"
                aria-label={`预览待发送图片 ${index + 1}`}
                title="点击预览图片"
                onClick={() =>
                  setPreview({
                    source: `data:${image.mimeType};base64,${image.data}`,
                    alt: `待发送图片 ${index + 1}`
                  })
                }
                sx={{
                  display: 'block',
                  p: 0,
                  border: 0,
                  bgcolor: 'transparent',
                  cursor: 'zoom-in'
                }}
              >
                <Box
                  component="img"
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={`待发送图片 ${index + 1}`}
                  sx={{
                    display: 'block',
                    width: 80,
                    height: 80,
                    objectFit: 'cover',
                    borderRadius: 1
                  }}
                />
              </Box>
              <IconButton
                size="small"
                aria-label={`移除图片 ${index + 1}`}
                onClick={() => onRemove?.(index)}
                sx={{ position: 'absolute', top: 0, right: 0, bgcolor: 'background.paper' }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          ))}
        </Stack>
      )}
      {error && (
        <Typography role="alert" variant="caption" color="error" sx={{ mb: 1 }}>
          {error}
        </Typography>
      )}
      <ImagePreviewDialog
        source={preview?.source ?? null}
        alt={preview?.alt ?? ''}
        onClose={() => setPreview(null)}
      />
    </>
  )
}
