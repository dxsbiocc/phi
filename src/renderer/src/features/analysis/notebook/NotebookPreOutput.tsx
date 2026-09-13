import { useMemo, useState } from 'react'
import { Box, Button, IconButton, Tooltip, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { TbTextWrap } from 'react-icons/tb'
import { PhiIcons } from '../../../icons'

const maxVisibleLines = 48
const maxVisibleChars = 5000
const CopyIcon = PhiIcons.action.copy

type FoldedOutput = {
  isFoldable: boolean
  previewText: string
  totalLines: number
}

function foldedOutput(text: string): FoldedOutput {
  const lines = text.split(/\r?\n/)
  const isFoldable = lines.length > maxVisibleLines || text.length > maxVisibleChars
  if (!isFoldable) {
    return { isFoldable: false, previewText: text, totalLines: lines.length }
  }

  const linePreview = lines.slice(0, maxVisibleLines).join('\n')
  const previewText =
    linePreview.length > maxVisibleChars
      ? `${linePreview.slice(0, maxVisibleChars)}\n...`
      : linePreview
  return { isFoldable: true, previewText, totalLines: lines.length }
}

function outputKindLabel(kind: string): string {
  if (kind.startsWith('stream:')) return kind.replace('stream:', '')
  if (kind === 'error') return 'error'
  if (kind.endsWith(':fallback')) return kind.replace(':fallback', '')
  if (kind === 'application/json') return 'JSON'
  return kind
}

export default function NotebookPreOutput({
  kind,
  text,
  tone = 'normal'
}: {
  kind: string
  text: string
  tone?: 'normal' | 'error'
}): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [wrapText, setWrapText] = useState(false)
  const folded = useMemo(() => foldedOutput(text), [text])
  const displayText = folded.isFoldable && !isExpanded ? folded.previewText : text
  const kindLabel = outputKindLabel(kind)
  // "text/plain" and ordinary stdout are the default, unremarkable cases.
  // Keep labels only where they distinguish the output, such as stderr,
  // errors, JSON/CSV/LaTeX rendered as text, and fallback mimes.
  const showKindLabel = kind !== 'text/plain' && kind !== 'stream:stdout'

  const copyOutput = async (): Promise<void> => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Box
      data-phi-notebook-output-pre="true"
      data-phi-notebook-output-folded={folded.isFoldable && !isExpanded ? 'true' : undefined}
      data-phi-notebook-output-expanded={folded.isFoldable && isExpanded ? 'true' : undefined}
      data-phi-notebook-output-wrap={wrapText ? 'true' : 'false'}
      sx={{
        position: 'relative',
        '&:hover .notebook-output-hover-actions, &:focus-within .notebook-output-hover-actions': {
          opacity: 1,
          pointerEvents: 'auto'
        }
      }}
    >
      <Box
        data-phi-notebook-output-toolbar="true"
        className="notebook-output-hover-actions"
        sx={{
          alignItems: 'center',
          display: 'flex',
          gap: 0.25,
          position: 'absolute',
          right: 0,
          top: 0,
          zIndex: 2,
          opacity: 0,
          pointerEvents: 'none',
          transition: 'opacity 140ms ease'
        }}
      >
        <Tooltip title={copied ? '已复制' : '复制输出'}>
          <IconButton
            size="small"
            aria-label={copied ? '已复制输出' : '复制输出'}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={() => {
              void copyOutput().catch((error) => {
                console.error('Failed to copy notebook output:', error)
              })
            }}
            data-phi-notebook-output-copy="true"
            sx={{
              width: 26,
              height: 26,
              p: 0,
              color: tone === 'error' ? 'error.main' : 'text.secondary',
              bgcolor: 'transparent',
              '&:hover': {
                color: tone === 'error' ? 'error.dark' : 'text.primary',
                bgcolor: (theme) =>
                  alpha(
                    tone === 'error' ? theme.palette.error.main : theme.palette.text.primary,
                    0.06
                  )
              }
            }}
          >
            <CopyIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title={wrapText ? '关闭输出换行' : '开启输出换行'}>
          <IconButton
            size="small"
            aria-label={wrapText ? '关闭输出换行' : '开启输出换行'}
            aria-pressed={wrapText ? 'true' : 'false'}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={() => setWrapText((current) => !current)}
            data-phi-notebook-output-wrap-toggle="true"
            sx={{
              width: 26,
              height: 26,
              p: 0,
              color: wrapText ? 'text.primary' : 'text.secondary',
              bgcolor: (theme) =>
                wrapText ? alpha(theme.palette.text.primary, 0.08) : 'transparent',
              '&:hover': {
                color: 'text.primary',
                bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08)
              }
            }}
          >
            <Box component={TbTextWrap} sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>
      {showKindLabel ? (
        <Box sx={{ mb: 0.45, pr: 7 }}>
          <Typography
            variant="caption"
            title={kindLabel}
            sx={{
              color: 'text.secondary',
              fontFamily: 'var(--font-mono)',
              maxWidth: 180,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {kindLabel}
          </Typography>
        </Box>
      ) : null}
      <Typography
        component="pre"
        data-phi-notebook-output-kind={kind}
        variant="body2"
        sx={{
          m: 0,
          // Caps the rendered height regardless of *why* the output is
          // tall -- many real lines (already handled by the fold above) or
          // a single very long line that word-wraps into dozens of rows
          // (e.g. an unformatted repr()), which the line/char-count fold
          // never catches since it has no real newlines to count.
          maxHeight: 420,
          pr: 7,
          overflowX: 'auto',
          overflowY: 'auto',
          whiteSpace: wrapText ? 'pre-wrap' : 'pre',
          overflowWrap: wrapText ? 'anywhere' : 'normal',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8rem',
          lineHeight: 1.6,
          color: tone === 'error' ? 'error.main' : 'text.primary'
        }}
      >
        {displayText}
      </Typography>
      {folded.isFoldable ? (
        <Box
          sx={{
            alignItems: 'center',
            display: 'flex',
            gap: 1,
            justifyContent: 'space-between',
            mt: 0.75
          }}
        >
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Output folded: {folded.totalLines} lines
          </Typography>
          <Button
            size="small"
            color={tone === 'error' ? 'error' : 'primary'}
            variant="text"
            onClick={() => setIsExpanded((current) => !current)}
            sx={{ minWidth: 0, px: 0.75, py: 0.25, textTransform: 'none' }}
          >
            {isExpanded ? '收起输出' : '展开完整输出'}
          </Button>
        </Box>
      ) : null}
    </Box>
  )
}
