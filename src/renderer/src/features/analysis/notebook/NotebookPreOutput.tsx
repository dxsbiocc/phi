import { useMemo, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
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
  const folded = useMemo(() => foldedOutput(text), [text])
  const displayText = folded.isFoldable && !isExpanded ? folded.previewText : text
  const kindLabel = outputKindLabel(kind)
  // "text/plain" is the default, unremarkable case (a plain repr/print) and
  // labeling it adds noise without telling the user anything -- keep the
  // label only where it actually distinguishes the output (stdout vs
  // stderr, error, JSON/CSV/LaTeX rendered as text, etc).
  const showKindLabel = kind !== 'text/plain'

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
    >
      <Box
        data-phi-notebook-output-toolbar="true"
        sx={{
          alignItems: 'center',
          display: 'flex',
          gap: 1,
          justifyContent: showKindLabel ? 'space-between' : 'flex-end',
          mb: 0.55
        }}
      >
        {showKindLabel ? (
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
        ) : null}
        <Button
          size="small"
          variant="text"
          color={tone === 'error' ? 'error' : 'inherit'}
          startIcon={<CopyIcon sx={{ fontSize: 14 }} />}
          onClick={() => {
            void copyOutput().catch((error) => {
              console.error('Failed to copy notebook output:', error)
            })
          }}
          data-phi-notebook-output-copy="true"
          sx={{
            minHeight: 24,
            minWidth: 0,
            px: 0.75,
            py: 0.1,
            color: tone === 'error' ? 'error.main' : 'text.secondary',
            fontSize: '0.72rem',
            textTransform: 'none',
            '&:hover': {
              bgcolor: (theme) =>
                alpha(
                  tone === 'error' ? theme.palette.error.main : theme.palette.text.primary,
                  0.06
                )
            }
          }}
        >
          {copied ? '已复制' : '复制输出'}
        </Button>
      </Box>
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
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
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
