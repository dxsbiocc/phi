import { Box, Button, Divider, Link, Tooltip, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { Fragment, isValidElement, useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FILE_TYPE_ICON_META, PhiIcons, fileIconForPath } from '../icons'
import { resolveLocalPath, tokenizeLocalPaths } from '../lib/localPaths'
import {
  normalizeHexColor,
  tokenizeMarkdownColors,
  type MarkdownColorToken
} from '../lib/markdownColors'
import { formatBytes } from '../lib/toolOutputPresentation'
import type { FileHoverPreview } from '../types'

const ContentCopyIcon = PhiIcons.action.copy
type HoverPreviewState =
  | { status: 'idle' | 'loading'; path: string }
  | { status: 'ready'; path: string; preview: FileHoverPreview }
  | { status: 'error'; path: string; message: string }
export type LocalPathKind = 'file' | 'directory'
const HOVER_PREVIEW_CACHE_LIMIT = 8
const HOVER_PREVIEW_CACHE_CONTENT_LIMIT = 8 * 1024 * 1024
const HOVER_PREVIEW_OPEN_DELAY_MS = 350
const HOVER_PREVIEW_FETCH_DELAY_MS = 150
const HOVER_TEXT_LINE_LIMIT = 12
const HOVER_SPREADSHEET_ROW_LIMIT = 8
const HOVER_SPREADSHEET_COLUMN_LIMIT = 6
const FILE_REFERENCE_NAME_PATTERN =
  /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}|[A-Z][A-Za-z0-9_-]*file)$/
const DOTFILE_REFERENCE_NAME_PATTERN = /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/
const BARE_FILE_REFERENCE_PATTERN =
  /(^|[^\w./-])(\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9_-]{0,15}|[A-Z][A-Za-z0-9_-]*file)(?=$|[\s,;:!?。，、；：（()）)\]}+.])/g
const localPathTooltipSlotProps = {
  tooltip: {
    sx: {
      bgcolor: 'background.paper',
      border: 1,
      borderColor: 'divider',
      boxShadow: 3,
      color: 'text.primary',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.75rem',
      lineHeight: 1.45,
      maxWidth: 420,
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

function LocalFileHoverPreview({
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
              message: error instanceof Error ? error.message : '无法预览文件'
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
        <Typography variant="caption" color="error">
          {state.message}
        </Typography>
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

function textFromNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textFromNode).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children)
  return ''
}

function languageFromCodeChild(children: ReactNode): string {
  const child = Array.isArray(children) ? children[0] : children
  if (!isValidElement<{ className?: string }>(child)) return '代码'

  const match = /language-([^\s]+)/.exec(child.props.className ?? '')
  return match?.[1] ?? '代码'
}

function CodeBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const language = languageFromCodeChild(children)
  const codeText = textFromNode(children).replace(/\n$/, '')

  const copyCode = async (): Promise<void> => {
    await navigator.clipboard.writeText(codeText)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Box
      sx={{
        my: 1,
        borderRadius: 2,
        bgcolor: (theme) =>
          theme.palette.mode === 'dark'
            ? alpha(theme.palette.common.white, 0.04)
            : alpha(theme.palette.primary.main, 0.035),
        border: 1,
        borderColor: 'divider',
        overflow: 'hidden',
        maxWidth: '100%',
        color: 'text.primary'
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          px: 1.5,
          py: 0.75,
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: (theme) =>
            theme.palette.mode === 'dark'
              ? alpha(theme.palette.common.white, 0.035)
              : alpha(theme.palette.primary.main, 0.06)
        }}
      >
        <Typography
          variant="caption"
          sx={{
            minWidth: 0,
            maxWidth: 160,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'text.secondary',
            fontFamily: 'var(--font-mono)'
          }}
          title={language}
        >
          {language}
        </Typography>
        <Button
          size="small"
          variant="text"
          startIcon={<ContentCopyIcon sx={{ fontSize: 15 }} />}
          onClick={() => {
            void copyCode().catch((error) => {
              console.error('Failed to copy code block:', error)
            })
          }}
          sx={{ minHeight: 28, textTransform: 'none', color: 'text.secondary' }}
        >
          {copied ? '已复制' : '复制'}
        </Button>
      </Box>
      <Box
        component="pre"
        sx={{
          m: 0,
          p: 1.5,
          overflowX: 'auto',
          maxWidth: '100%',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.82rem',
          lineHeight: 1.6,
          color: 'text.primary',
          '& code': {
            color: 'inherit',
            fontWeight: 400
          }
        }}
      >
        {children}
      </Box>
    </Box>
  )
}

function LocalPathButton({
  text,
  absolutePath,
  pathKind = 'file',
  onOpenLocalPath
}: {
  text: string
  absolutePath: string
  pathKind?: LocalPathKind
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void
}): React.JSX.Element {
  const label = localPathLabel(text, absolutePath)
  const pathIcon =
    pathKind === 'directory' ? FILE_TYPE_ICON_META.directory : fileIconForPath(absolutePath)
  const LocalFileIcon = pathIcon.Icon
  const supportsHoverPreview = pathKind === 'file'
  const [hoverPreviewActive, setHoverPreviewActive] = useState(false)
  const button = (
    <Tooltip
      title={
        supportsHoverPreview ? (
          <LocalFileHoverPreview absolutePath={absolutePath} shouldLoad={hoverPreviewActive} />
        ) : (
          absolutePath
        )
      }
      placement="top-start"
      arrow
      slotProps={localPathTooltipSlotProps}
      enterDelay={HOVER_PREVIEW_OPEN_DELAY_MS}
      leaveDelay={80}
      onOpen={() => {
        if (supportsHoverPreview) setHoverPreviewActive(true)
      }}
      onClose={() => {
        if (supportsHoverPreview) setHoverPreviewActive(false)
      }}
    >
      <Box
        component="button"
        type="button"
        data-phi-slot="local-file-link"
        data-phi-file-kind={pathIcon.kind}
        data-phi-path={absolutePath}
        aria-label={`${pathKind === 'directory' ? '打开目录' : '打开文件'} ${absolutePath}`}
        onClick={() => {
          if (onOpenLocalPath) {
            onOpenLocalPath(absolutePath, pathKind)
            return
          }

          void window.api.revealPath(absolutePath).catch((error) => {
            console.error('Failed to reveal local path:', error)
          })
        }}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.45,
          maxWidth: '100%',
          minWidth: 0,
          px: 0.25,
          py: 0,
          mx: 0.1,
          border: 0,
          borderRadius: 0.75,
          bgcolor: 'transparent',
          color: 'primary.main',
          font: 'inherit',
          fontWeight: 500,
          lineHeight: 'inherit',
          verticalAlign: 'baseline',
          cursor: 'pointer',
          overflowWrap: 'normal',
          textDecoration: 'none',
          '&:hover': {
            bgcolor: (theme) => alpha(theme.palette.primary.main, 0.08),
            color: 'primary.dark'
          },
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2
          }
        }}
      >
        <LocalFileIcon
          fontSize="inherit"
          sx={{ color: pathIcon.color, fontSize: '0.95em', transform: 'translateY(1px)' }}
        />
        <Box
          component="span"
          sx={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {label}
        </Box>
      </Box>
    </Tooltip>
  )

  if (!supportsHoverPreview) return button

  return (
    <Box
      component="span"
      data-phi-slot="local-file-hover-preview"
      data-phi-hover-preview-path={absolutePath}
      sx={{
        display: 'inline',
        maxWidth: '100%',
        minWidth: 0
      }}
    >
      {button}
    </Box>
  )
}

function fileNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function localPathLabel(text: string, absolutePath: string): string {
  const trimmed = text.trim()
  const isPathLikeLabel =
    trimmed === absolutePath ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    (trimmed.includes('/') && !/\s/.test(trimmed))
  if (!trimmed || isPathLikeLabel) {
    return fileNameFromPath(absolutePath)
  }
  return trimmed
}

function localHrefToPath(href: string | undefined, cwd: string): string | null {
  if (!href) return null

  const withoutHash = href.split('#')[0]
  let decoded = withoutHash
  try {
    decoded = decodeURIComponent(withoutHash)
  } catch {
    decoded = withoutHash
  }

  const lineMatch = /^(.*):\d+$/.exec(decoded)
  const candidate = lineMatch?.[1] ?? decoded
  return resolveLocalPath(candidate, cwd)
}

function stripLineReference(path: string): string {
  return /^(.*):\d+$/.exec(path)?.[1] ?? path
}

function normalizePathIdentity(path: string): string {
  const stripped = stripLineReference(path.trim())
  if (stripped === '/') return stripped
  return stripped.replace(/\/+$/, '')
}

function localPathKindForReference(
  text: string,
  absolutePath: string,
  cwd: string,
  inferUnknownExtensionlessDirectory: boolean
): LocalPathKind {
  const visiblePath = stripLineReference(text.trim())
  if (visiblePath.endsWith('/')) return 'directory'

  const normalizedPath = normalizePathIdentity(absolutePath)
  if (cwd && normalizedPath === normalizePathIdentity(cwd)) return 'directory'
  if (!inferUnknownExtensionlessDirectory) return 'file'

  const icon = fileIconForPath(normalizedPath)
  const name = fileNameFromPath(normalizedPath)
  if (icon.kind === 'text' && name && !name.includes('.')) return 'directory'

  return 'file'
}

function isBareFileReference(path: string): boolean {
  if (!path || path.includes('\\') || /\s/.test(path) || path.endsWith('/')) return false
  if (path.startsWith('-')) return false

  const parts = path.split('/')
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) return false

  const name = parts[parts.length - 1]
  return FILE_REFERENCE_NAME_PATTERN.test(name) || DOTFILE_REFERENCE_NAME_PATTERN.test(name)
}

function inlineCodeFilePath(text: string, cwd: string): string | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed !== text || trimmed.includes('\n')) return null

  const withoutLine = stripLineReference(trimmed)
  const explicitPath = resolveLocalPath(withoutLine, cwd)
  if (explicitPath) return explicitPath

  if (!cwd || !isBareFileReference(withoutLine)) return null
  return resolveLocalPath(`./${withoutLine}`, cwd)
}

type BareFileReferenceToken =
  { kind: 'text'; text: string } | { kind: 'file'; text: string; absolutePath: string }

function bareFileReferencePath(text: string, cwd: string): string | null {
  if (!cwd || !isBareFileReference(text)) return null

  const fileIcon = fileIconForPath(text)
  if (fileIcon.kind === 'text') return null

  return resolveLocalPath(`./${text}`, cwd)
}

function tokenizeBareFileReferences(text: string, cwd: string): BareFileReferenceToken[] {
  if (!cwd) return [{ kind: 'text', text }]

  const tokens: BareFileReferenceToken[] = []
  let cursor = 0

  for (const match of text.matchAll(BARE_FILE_REFERENCE_PATTERN)) {
    const leading = match[1] ?? ''
    const candidate = match[2] ?? ''
    const start = (match.index ?? 0) + leading.length
    const end = start + candidate.length
    const absolutePath = bareFileReferencePath(candidate, cwd)
    if (!absolutePath) continue

    if (start > cursor) tokens.push({ kind: 'text', text: text.slice(cursor, start) })
    tokens.push({ kind: 'file', text: candidate, absolutePath })
    cursor = end
  }

  if (cursor < text.length) tokens.push({ kind: 'text', text: text.slice(cursor) })
  return tokens
}

function ColorSwatch({ color }: { color: string }): React.JSX.Element {
  return (
    <Box
      component="span"
      data-phi-slot="markdown-color-swatch"
      aria-label={`颜色 ${color}`}
      title={color}
      sx={{
        display: 'inline-block',
        width: 14,
        height: 14,
        minWidth: 14,
        maxWidth: 14,
        aspectRatio: '1 / 1',
        boxSizing: 'border-box',
        borderRadius: '50%',
        border: 1,
        borderColor: 'divider',
        boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.38)',
        verticalAlign: '-0.15em',
        flexShrink: 0
      }}
      style={{ backgroundColor: color }}
    />
  )
}

const inlineCodeSx = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.85em',
  px: 0.6,
  py: 0.2,
  borderRadius: 1,
  bgcolor: 'rgba(148, 163, 184, 0.15)'
} as const

function ColorCode({ color }: { color: string }): React.JSX.Element {
  return (
    <Box
      component="span"
      data-phi-slot="markdown-color-token"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        mx: 0.15,
        verticalAlign: 'baseline',
        whiteSpace: 'nowrap'
      }}
    >
      <ColorSwatch color={color} />
      <Box component="code" sx={inlineCodeSx}>
        {color}
      </Box>
    </Box>
  )
}

function ColorPalettePreview({ colors }: { colors: string[] }): React.JSX.Element {
  return (
    <Box
      component="span"
      data-phi-slot="markdown-color-palette"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 0.75,
        mx: 0.5,
        verticalAlign: 'middle'
      }}
    >
      {colors.map((color, index) => (
        <ColorCode key={`${color}-${index}`} color={color} />
      ))}
    </Box>
  )
}

function renderColorToken(token: MarkdownColorToken, key: string): ReactNode {
  if (token.kind === 'color') return <ColorCode key={key} color={token.color} />
  if (token.kind === 'palette') return <ColorPalettePreview key={key} colors={token.colors} />
  return <Fragment key={key}>{token.text}</Fragment>
}

function renderDecoratedText(
  text: string,
  cwd: string,
  keyPrefix: string,
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void
): ReactNode[] {
  const nodes: ReactNode[] = []

  tokenizeLocalPaths(text, cwd).forEach((token, pathIndex) => {
    if (token.kind === 'path') {
      nodes.push(
        <LocalPathButton
          key={`${keyPrefix}-path-${pathIndex}-${token.absolutePath}`}
          text={token.text}
          absolutePath={token.absolutePath}
          pathKind={localPathKindForReference(token.text, token.absolutePath, cwd, true)}
          onOpenLocalPath={onOpenLocalPath}
        />
      )
      return
    }

    tokenizeBareFileReferences(token.text, cwd).forEach((fileToken, fileIndex) => {
      if (fileToken.kind === 'file') {
        nodes.push(
          <LocalPathButton
            key={`${keyPrefix}-file-${pathIndex}-${fileIndex}-${fileToken.absolutePath}`}
            text={fileToken.text}
            absolutePath={fileToken.absolutePath}
            pathKind="file"
            onOpenLocalPath={onOpenLocalPath}
          />
        )
        return
      }

      nodes.push(
        ...tokenizeMarkdownColors(fileToken.text).map((colorToken, colorIndex) =>
          renderColorToken(colorToken, `${keyPrefix}-color-${pathIndex}-${fileIndex}-${colorIndex}`)
        )
      )
    })
  })

  return nodes
}

function renderInlineChildren(
  children: ReactNode,
  cwd: string,
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void
): ReactNode {
  if (typeof children === 'string') {
    return renderDecoratedText(children, cwd, 'inline', onOpenLocalPath)
  }
  if (Array.isArray(children)) {
    return children.map((child, index) => (
      <Fragment key={index}>{renderInlineChildren(child, cwd, onOpenLocalPath)}</Fragment>
    ))
  }
  return children
}

function InlineCode({
  children,
  cwd,
  onOpenLocalPath
}: {
  children?: ReactNode
  cwd: string
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void
}): React.JSX.Element {
  const codeText = textFromNode(children)
  const color = normalizeHexColor(codeText)
  if (color) return <ColorCode color={color} />
  const localPath = inlineCodeFilePath(codeText, cwd)
  if (localPath) {
    const pathKind = localPathKindForReference(codeText, localPath, cwd, true)
    return (
      <LocalPathButton
        text={codeText}
        absolutePath={localPath}
        pathKind={pathKind}
        onOpenLocalPath={onOpenLocalPath}
      />
    )
  }

  return (
    <Box component="code" sx={inlineCodeSx}>
      {children}
    </Box>
  )
}

function MarkdownContent({
  text,
  cwd = '',
  onOpenLocalPath
}: {
  text: string
  cwd?: string
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void
}): React.JSX.Element {
  return (
    <Box
      sx={{
        fontSize: '0.95rem',
        lineHeight: 1.7,
        minWidth: 0,
        maxWidth: '100%',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        '& > :first-of-type': { mt: 0 },
        '& > :last-child': { mb: 0 }
      }}
    >
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <Typography variant="body1" sx={{ my: 1, fontSize: 'inherit', lineHeight: 'inherit' }}>
              {renderInlineChildren(children, cwd, onOpenLocalPath)}
            </Typography>
          ),
          h1: ({ children }) => (
            <Typography variant="h6" component="h1" sx={{ mt: 2.5, mb: 1, fontWeight: 700 }}>
              {children}
            </Typography>
          ),
          h2: ({ children }) => (
            <Typography variant="subtitle1" component="h2" sx={{ mt: 2, mb: 1, fontWeight: 700 }}>
              {children}
            </Typography>
          ),
          h3: ({ children }) => (
            <Typography
              variant="subtitle2"
              component="h3"
              sx={{ mt: 1.5, mb: 0.5, fontWeight: 700 }}
            >
              {children}
            </Typography>
          ),
          ul: ({ children }) => (
            <Box component="ul" sx={{ my: 1, pl: 3, '& li': { mb: 0.5 } }}>
              {children}
            </Box>
          ),
          ol: ({ children }) => (
            <Box component="ol" sx={{ my: 1, pl: 3, '& li': { mb: 0.5 } }}>
              {children}
            </Box>
          ),
          li: ({ children }) => (
            <Typography component="li" sx={{ fontSize: 'inherit', lineHeight: 'inherit' }}>
              {renderInlineChildren(children, cwd, onOpenLocalPath)}
            </Typography>
          ),
          strong: ({ children }) => (
            <Box component="strong" sx={{ fontWeight: 700 }}>
              {renderInlineChildren(children, cwd, onOpenLocalPath)}
            </Box>
          ),
          em: ({ children }) => (
            <Box component="em" sx={{ fontStyle: 'italic' }}>
              {renderInlineChildren(children, cwd, onOpenLocalPath)}
            </Box>
          ),
          a: ({ href, children }) => {
            const localPath = localHrefToPath(href, cwd)
            if (localPath) {
              const pathKind = localPathKindForReference(
                textFromNode(children),
                localPath,
                cwd,
                true
              )
              return (
                <LocalPathButton
                  text={textFromNode(children)}
                  absolutePath={localPath}
                  pathKind={pathKind}
                  onOpenLocalPath={onOpenLocalPath}
                />
              )
            }

            return (
              <Link href={href} target="_blank" rel="noreferrer" sx={{ color: 'primary.light' }}>
                {children}
              </Link>
            )
          },
          hr: () => <Divider sx={{ my: 1.5 }} />,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ className, children }) =>
            className ? (
              <Box component="code" sx={{ fontFamily: 'var(--font-mono)', fontSize: 'inherit' }}>
                {children}
              </Box>
            ) : (
              <InlineCode cwd={cwd} onOpenLocalPath={onOpenLocalPath}>
                {children}
              </InlineCode>
            ),
          blockquote: ({ children }) => (
            <Box
              component="blockquote"
              sx={{
                m: 0,
                my: 1,
                pl: 2,
                borderLeft: 3,
                borderColor: 'grey.700',
                color: 'text.secondary'
              }}
            >
              {children}
            </Box>
          ),
          table: ({ children }) => (
            <Box sx={{ overflowX: 'auto', my: 1 }}>
              <Box
                component="table"
                sx={{
                  borderCollapse: 'collapse',
                  '& th, & td': {
                    border: 1,
                    borderColor: 'grey.800',
                    px: 1.5,
                    py: 0.5,
                    fontSize: '0.88rem',
                    textAlign: 'left'
                  },
                  '& th': { bgcolor: 'rgba(148, 163, 184, 0.08)', fontWeight: 700 }
                }}
              >
                {children}
              </Box>
            </Box>
          ),
          th: ({ children }) => (
            <Box component="th" sx={{ fontWeight: 700 }}>
              {renderInlineChildren(children, cwd, onOpenLocalPath)}
            </Box>
          ),
          td: ({ children }) => (
            <Box component="td">{renderInlineChildren(children, cwd, onOpenLocalPath)}</Box>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </Box>
  )
}

export default MarkdownContent
