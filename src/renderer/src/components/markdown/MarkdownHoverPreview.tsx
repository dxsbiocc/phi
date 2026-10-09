import { Box, Typography } from '@mui/material'
import { useEffect, useState } from 'react'
import { formatBytes } from '../../lib/toolOutputPresentation'
import { describeLocalFileHoverError } from '../../lib/markdownLocalPathPreview'
import type { FileHoverPreview } from '../../types'

type HoverPreviewState =
  | { status: 'idle' | 'loading'; path: string }
  | { status: 'ready'; path: string; preview: FileHoverPreview }
  | {
      status: 'error'
      path: string
      description: ReturnType<typeof describeLocalFileHoverError>
    }

const HOVER_PREVIEW_CACHE_LIMIT = 8
const HOVER_PREVIEW_CACHE_CONTENT_LIMIT = 8 * 1024 * 1024
const HOVER_PREVIEW_FETCH_DELAY_MS = 150
const HOVER_TEXT_LINE_LIMIT = 12
const HOVER_SPREADSHEET_ROW_LIMIT = 8
const HOVER_SPREADSHEET_COLUMN_LIMIT = 6

const hoverPreviewCache = new Map<string, FileHoverPreview>()
const hoverPreviewRequests = new Map<string, Promise<FileHoverPreview>>()

function hoverPreviewApi(): {
  hoverPreviewFile: (path: string) => Promise<FileHoverPreview>
} | null {
  if (typeof window === 'undefined') return null

  const api = (window as unknown as { api?: { hoverPreviewFile?: unknown } }).api
  return typeof api?.hoverPreviewFile === 'function'
    ? { hoverPreviewFile: api.hoverPreviewFile as (path: string) => Promise<FileHoverPreview> }
    : null
}

function cachedHoverPreview(path: string): FileHoverPreview | null {
  const cached = hoverPreviewCache.get(path)
  if (!cached) return null
  hoverPreviewCache.delete(path)
  hoverPreviewCache.set(path, cached)
  return cached
}

function hoverPreviewCacheWeight(preview: FileHoverPreview): number {
  if (preview.kind === 'image') return preview.dataUrl.length
  if (preview.kind === 'spreadsheet' || preview.kind === 'text') return preview.content.length
  return 0
}

function currentHoverPreviewCacheWeight(): number {
  let total = 0
  for (const preview of hoverPreviewCache.values()) {
    total += hoverPreviewCacheWeight(preview)
  }
  return total
}

function rememberHoverPreview(preview: FileHoverPreview): void {
  hoverPreviewCache.set(preview.path, preview)
  while (
    hoverPreviewCache.size > HOVER_PREVIEW_CACHE_LIMIT ||
    currentHoverPreviewCacheWeight() > HOVER_PREVIEW_CACHE_CONTENT_LIMIT
  ) {
    const oldestPath = hoverPreviewCache.keys().next().value
    if (!oldestPath) break
    hoverPreviewCache.delete(oldestPath)
  }
}

function requestHoverPreview(path: string): Promise<FileHoverPreview> | null {
  const cached = cachedHoverPreview(path)
  if (cached) return Promise.resolve(cached)

  const existing = hoverPreviewRequests.get(path)
  if (existing) return existing

  const api = hoverPreviewApi()
  if (!api) return null

  const request = api
    .hoverPreviewFile(path)
    .then((preview) => {
      rememberHoverPreview(preview)
      return preview
    })
    .finally(() => {
      hoverPreviewRequests.delete(path)
    })
  hoverPreviewRequests.set(path, request)
  return request
}

function previewSubtitle(preview: FileHoverPreview): string {
  let label: string
  switch (preview.kind) {
    case 'spreadsheet':
      label = preview.format.toUpperCase()
      break
    case 'metadata':
      label = preview.mimeType === 'application/pdf' ? 'PDF' : 'File'
      break
    case 'image':
      label = 'Image'
      break
    case 'text':
      label = 'Text'
      break
  }
  const suffix = preview.truncated ? ` · ${formatBytes(preview.previewBytes)} preview` : ''
  return `${label} · ${formatBytes(preview.bytes)}${suffix}`
}

function metadataReasonLabel(
  reason: Extract<FileHoverPreview, { kind: 'metadata' }>['reason']
): string {
  if (reason === 'large_file') return '文件较大，仅显示信息'
  if (reason === 'pdf') return 'PDF 文件，请在右侧打开查看'
  if (reason === 'binary') return '二进制文件，仅显示信息'
  return '暂不支持内容预览'
}

function delimitedPreviewRows(
  preview: Extract<FileHoverPreview, { kind: 'spreadsheet' }>
): string[][] {
  const delimiter = preview.format === 'tsv' ? '\t' : ','
  return preview.content
    .split(/\r?\n/)
    .filter((row) => row.length > 0)
    .slice(0, HOVER_SPREADSHEET_ROW_LIMIT)
    .map((row) => row.split(delimiter).slice(0, HOVER_SPREADSHEET_COLUMN_LIMIT))
}

function HoverPreviewContent({ preview }: { preview: FileHoverPreview }): React.JSX.Element {
  if (preview.kind === 'image') {
    return (
      <Box
        component="img"
        src={preview.dataUrl}
        alt={preview.name}
        data-phi-slot="local-file-hover-image"
        sx={{
          display: 'block',
          width: '100%',
          maxHeight: 260,
          borderRadius: 1,
          border: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
          objectFit: 'contain'
        }}
      />
    )
  }

  if (preview.kind === 'spreadsheet') {
    const rows = delimitedPreviewRows(preview)
    return (
      <Box
        data-phi-slot="local-file-hover-spreadsheet"
        sx={{
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          overflow: 'hidden',
          bgcolor: 'background.paper'
        }}
      >
        {rows.map((row, rowIndex) => (
          <Box
            key={rowIndex}
            sx={{
              display: 'grid',
              gridTemplateColumns: `32px repeat(${Math.max(1, row.length)}, minmax(52px, 1fr))`,
              borderTop: rowIndex === 0 ? 0 : 1,
              borderColor: 'divider'
            }}
          >
            <Box
              component="span"
              sx={{
                px: 0.5,
                py: 0.35,
                color: 'text.secondary',
                bgcolor: 'action.hover',
                textAlign: 'right',
                userSelect: 'none'
              }}
            >
              {rowIndex + 1}
            </Box>
            {row.map((cell, cellIndex) => (
              <Box
                key={cellIndex}
                component="span"
                title={cell}
                sx={{
                  px: 0.65,
                  py: 0.35,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  borderLeft: 1,
                  borderColor: 'divider',
                  color: rowIndex === 0 ? 'text.primary' : 'text.secondary',
                  fontWeight: rowIndex === 0 ? 700 : 400
                }}
              >
                {cell}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  }

  if (preview.kind === 'text') {
    const lines = preview.content.split(/\r?\n/).slice(0, HOVER_TEXT_LINE_LIMIT)
    return (
      <Box
        component="pre"
        data-phi-slot="local-file-hover-text"
        sx={{
          m: 0,
          p: 1,
          maxHeight: 220,
          overflow: 'hidden',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          bgcolor: 'background.paper',
          color: 'text.primary',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.76rem',
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap'
        }}
      >
        {lines.join('\n')}
      </Box>
    )
  }

  return (
    <Typography
      data-phi-slot="local-file-hover-metadata"
      variant="caption"
      sx={{ color: 'text.secondary' }}
    >
      {metadataReasonLabel(preview.reason)}
    </Typography>
  )
}

export function LocalFileHoverPreview({
  absolutePath,
  shouldLoad
}: {
  absolutePath: string
  shouldLoad: boolean
}): React.JSX.Element {
  const [state, setState] = useState<HoverPreviewState>({
    status: 'idle',
    path: absolutePath
  })

  useEffect(() => {
    if (!shouldLoad) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      const request = requestHoverPreview(absolutePath)
      if (!request) return

      void request
        .then((preview) => {
          if (!cancelled) setState({ status: 'ready', path: absolutePath, preview })
        })
        .catch((error) => {
          if (!cancelled) {
            setState({
              status: 'error',
              path: absolutePath,
              description: describeLocalFileHoverError(error)
            })
          }
          console.error('Failed to preview local file on hover:', error)
        })
    }, HOVER_PREVIEW_FETCH_DELAY_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [absolutePath, shouldLoad])

  const preview = state.path === absolutePath && state.status === 'ready' ? state.preview : null

  return (
    <Box
      data-phi-slot="local-file-hover-preview-card"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0.75,
        width: 360,
        maxWidth: 'min(360px, calc(100vw - 48px))'
      }}
    >
      {state.path === absolutePath && state.status === 'ready' && preview ? (
        <HoverPreviewContent preview={preview} />
      ) : null}
      {state.path === absolutePath && state.status === 'error' ? (
        <Box
          data-phi-slot="local-file-hover-error"
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 0.35,
            p: 1,
            border: 1,
            borderColor: 'warning.main',
            borderRadius: 1,
            bgcolor: 'warning.main',
            color: 'warning.contrastText'
          }}
        >
          <Typography variant="caption" sx={{ fontWeight: 700, color: 'inherit' }}>
            {state.description.title}
          </Typography>
          <Typography variant="caption" sx={{ color: 'inherit' }}>
            {state.description.message}
          </Typography>
          {state.description.action ? (
            <Typography variant="caption" sx={{ color: 'inherit', fontWeight: 600 }}>
              {state.description.action}
            </Typography>
          ) : null}
        </Box>
      ) : null}
      {preview ? (
        <Typography data-phi-slot="local-file-hover-meta" variant="caption" color="text.secondary">
          {previewSubtitle(preview)}
        </Typography>
      ) : null}
      <Box
        component="span"
        data-phi-slot="local-file-hover-path"
        sx={{
          color: 'text.secondary',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.75rem',
          lineHeight: 1.35,
          overflowWrap: 'anywhere'
        }}
      >
        {absolutePath}
      </Box>
    </Box>
  )
}
