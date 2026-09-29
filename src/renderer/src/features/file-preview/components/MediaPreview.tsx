import { Box, Typography } from '@mui/material'
import { useEffect, useState } from 'react'
import type { FilePreview } from '../../../types'
import { pdfObjectUrlFromDataUrl } from '../lib/pdfObjectUrl'

function PdfPreview({ file }: { file: Extract<FilePreview, { kind: 'pdf' }> }): React.JSX.Element {
  const [preview, setPreview] = useState<{ source: string; url: string } | null>(null)
  const [errorSource, setErrorSource] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let url: string | undefined
    queueMicrotask(() => {
      if (cancelled) return
      try {
        url = pdfObjectUrlFromDataUrl(file.dataUrl)
        setPreview({ source: file.dataUrl, url })
      } catch {
        setErrorSource(file.dataUrl)
      }
    })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [file.dataUrl])

  const url = preview?.source === file.dataUrl ? preview.url : null
  return (
    <Box
      data-phi-media-preview="pdf"
      role="region"
      aria-label={`PDF 预览：${file.name}`}
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        bgcolor: 'background.default',
        display: 'flex'
      }}
    >
      {url ? (
        <Box
          component="iframe"
          src={url}
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
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ m: 'auto' }}>
          {errorSource === file.dataUrl ? 'PDF 预览失败' : '正在准备 PDF 预览…'}
        </Typography>
      )}
    </Box>
  )
}

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

  return <PdfPreview file={file} />
}
