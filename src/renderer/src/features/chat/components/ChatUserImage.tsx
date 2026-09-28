import { Box, Typography } from '@mui/material'
import { useEffect, useState } from 'react'

import type { PromptImageInput, StoredPromptImage } from '../../../../../shared/promptImageTypes'
import { getRendererApi } from '../../../lib/rendererApi'
import { ImagePreviewDialog } from './ImagePreviewDialog'

type MessageImage = PromptImageInput | StoredPromptImage

export function ChatUserImage({
  image,
  index
}: {
  image: MessageImage
  index: number
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<{ key: string; source?: string; failed?: boolean } | null>(
    null
  )
  const [previewOpen, setPreviewOpen] = useState(false)
  const key = 'data' in image ? null : `${image.sessionId}:${image.id}`

  useEffect(() => {
    if ('data' in image) return
    let active = true
    const currentKey = `${image.sessionId}:${image.id}`
    void getRendererApi()
      .readPromptImage(image)
      .then((result) => {
        if (active)
          setLoaded({ key: currentKey, source: `data:${result.mimeType};base64,${result.data}` })
      })
      .catch(() => {
        if (active) setLoaded({ key: currentKey, failed: true })
      })
    return () => {
      active = false
    }
  }, [image])

  const source =
    'data' in image
      ? `data:${image.mimeType};base64,${image.data}`
      : loaded?.key === key
        ? loaded.source
        : null
  if (loaded?.key === key && loaded.failed) {
    return <Typography variant="caption">图片无法读取</Typography>
  }
  if (!source) return <Typography variant="caption">正在加载图片…</Typography>
  return (
    <>
      <Box
        component="button"
        type="button"
        aria-label={`预览消息图片 ${index + 1}`}
        title="点击预览图片"
        onClick={() => setPreviewOpen(true)}
        sx={{ display: 'block', p: 0, border: 0, bgcolor: 'transparent', cursor: 'zoom-in' }}
      >
        <Box
          component="img"
          src={source}
          alt={`消息图片 ${index + 1}`}
          sx={{
            display: 'block',
            maxWidth: 320,
            maxHeight: 320,
            width: 'auto',
            height: 'auto',
            borderRadius: 1
          }}
        />
      </Box>
      <ImagePreviewDialog
        source={previewOpen ? source : null}
        alt={`消息图片 ${index + 1}`}
        onClose={() => setPreviewOpen(false)}
      />
    </>
  )
}
