import { Box, Link, Tooltip, Typography } from '@mui/material'
import { useEffect, useState } from 'react'
import type {
  DatabaseWebImagePreview,
  DatabaseWebPreviewKind
} from '../../../../shared/databaseWebPreview'
import { HOVER_PREVIEW_OPEN_DELAY_MS } from '../../lib/markdownLocalPathPreview'

type DatabasePreviewState =
  | { status: 'idle' | 'loading'; sourceUrl: string }
  | { status: 'ready'; sourceUrl: string; preview: DatabaseWebImagePreview }
  | { status: 'error'; sourceUrl: string; message: string }

const DATABASE_PREVIEW_FETCH_DELAY_MS = 150
const DATABASE_PREVIEW_CACHE_LIMIT = 12
const databasePreviewCache = new Map<string, DatabaseWebImagePreview>()
const databasePreviewRequests = new Map<string, Promise<DatabaseWebImagePreview>>()

const databasePreviewTooltipSlotProps = {
  tooltip: {
    sx: {
      bgcolor: 'background.paper',
      border: 1,
      borderColor: 'divider',
      boxShadow: 3,
      color: 'text.primary',
      fontSize: '0.75rem',
      lineHeight: 1.45,
      maxWidth: 540,
      overflowWrap: 'anywhere'
    }
  },
  arrow: {
    sx: {
      color: 'background.paper',
      '&::before': {
        border: '1px solid',
        borderColor: 'divider',
        boxSizing: 'border-box'
      }
    }
  }
} as const

function databasePreviewApi(): {
  previewDatabaseWebImage: (url: string) => Promise<DatabaseWebImagePreview>
} | null {
  if (typeof window === 'undefined') return null

  const api = (window as unknown as { api?: { previewDatabaseWebImage?: unknown } }).api
  return typeof api?.previewDatabaseWebImage === 'function'
    ? {
        previewDatabaseWebImage: api.previewDatabaseWebImage as (
          url: string
        ) => Promise<DatabaseWebImagePreview>
      }
    : null
}

function cachedDatabasePreview(sourceUrl: string): DatabaseWebImagePreview | null {
  const cached = databasePreviewCache.get(sourceUrl)
  if (!cached) return null
  databasePreviewCache.delete(sourceUrl)
  databasePreviewCache.set(sourceUrl, cached)
  return cached
}

function rememberDatabasePreview(preview: DatabaseWebImagePreview): void {
  databasePreviewCache.set(preview.sourceUrl, preview)
  while (databasePreviewCache.size > DATABASE_PREVIEW_CACHE_LIMIT) {
    const oldestUrl = databasePreviewCache.keys().next().value
    if (!oldestUrl) break
    databasePreviewCache.delete(oldestUrl)
  }
}

function requestDatabasePreview(sourceUrl: string): Promise<DatabaseWebImagePreview> | null {
  const cached = cachedDatabasePreview(sourceUrl)
  if (cached) return Promise.resolve(cached)

  const existing = databasePreviewRequests.get(sourceUrl)
  if (existing) return existing

  const api = databasePreviewApi()
  if (!api) return null

  const request = api
    .previewDatabaseWebImage(sourceUrl)
    .then((preview) => {
      rememberDatabasePreview(preview)
      return preview
    })
    .finally(() => {
      databasePreviewRequests.delete(sourceUrl)
    })
  databasePreviewRequests.set(sourceUrl, request)
  return request
}

function databaseKindLabel(kind: DatabaseWebPreviewKind): string {
  if (kind === 'kegg-pathway') return 'KEGG 通路图'
  return 'STRING 网络'
}

function DatabaseHoverImagePreviewCard({
  sourceUrl,
  kind,
  shouldLoad
}: {
  sourceUrl: string
  kind: DatabaseWebPreviewKind
  shouldLoad: boolean
}): React.JSX.Element {
  const [state, setState] = useState<DatabasePreviewState>({
    status: 'idle',
    sourceUrl
  })

  useEffect(() => {
    if (!shouldLoad) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      const request = requestDatabasePreview(sourceUrl)
      if (!request) return

      void request
        .then((preview) => {
          if (!cancelled) setState({ status: 'ready', sourceUrl, preview })
        })
        .catch((error) => {
          if (!cancelled) {
            setState({
              status: 'error',
              sourceUrl,
              message: error instanceof Error ? error.message : '无法加载数据库网页预览'
            })
          }
          console.error('Failed to preview database webpage:', error)
        })
    }, DATABASE_PREVIEW_FETCH_DELAY_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [sourceUrl, shouldLoad])

  const preview = state.sourceUrl === sourceUrl && state.status === 'ready' ? state.preview : null

  return (
    <Box
      data-phi-slot="database-web-hover-preview-card"
      data-phi-database-kind={kind}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0.75,
        width: 500,
        maxWidth: 'min(500px, calc(100vw - 48px))'
      }}
    >
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700 }}>
        {preview?.label ?? databaseKindLabel(kind)}
      </Typography>
      {preview ? (
        <Box
          component="img"
          src={preview.dataUrl}
          alt={preview.label}
          data-phi-slot="database-web-hover-image"
          sx={{
            display: 'block',
            width: '100%',
            maxHeight: 320,
            borderRadius: 1,
            border: 1,
            borderColor: 'divider',
            bgcolor: 'common.white',
            objectFit: 'contain'
          }}
        />
      ) : null}
      {state.sourceUrl === sourceUrl && state.status === 'error' ? (
        <Typography variant="caption" color="error">
          {state.message}
        </Typography>
      ) : null}
      {!preview && state.status !== 'error' ? (
        <Typography variant="caption" color="text.secondary">
          正在加载预览...
        </Typography>
      ) : null}
      <Box
        component="span"
        data-phi-slot="database-web-hover-url"
        sx={{
          color: 'text.secondary',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.75rem',
          lineHeight: 1.35,
          overflowWrap: 'anywhere'
        }}
      >
        {sourceUrl}
      </Box>
    </Box>
  )
}

export function DatabaseHoverImagePreviewLink({
  href,
  label,
  kind
}: {
  href: string
  label: string
  kind: DatabaseWebPreviewKind
}): React.JSX.Element {
  const [hoverPreviewActive, setHoverPreviewActive] = useState(false)

  return (
    <Tooltip
      title={
        <DatabaseHoverImagePreviewCard
          sourceUrl={href}
          kind={kind}
          shouldLoad={hoverPreviewActive}
        />
      }
      arrow
      placement="top"
      enterDelay={HOVER_PREVIEW_OPEN_DELAY_MS}
      enterNextDelay={HOVER_PREVIEW_OPEN_DELAY_MS}
      slotProps={databasePreviewTooltipSlotProps}
      onOpen={() => setHoverPreviewActive(true)}
      onClose={() => setHoverPreviewActive(false)}
    >
      <Link
        href={href}
        target="_blank"
        rel="noreferrer"
        data-phi-slot="database-web-preview-link"
        data-phi-database-kind={kind}
        sx={{ color: 'primary.light' }}
      >
        {label}
      </Link>
    </Tooltip>
  )
}
