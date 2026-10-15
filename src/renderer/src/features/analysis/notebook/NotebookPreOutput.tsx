import { useContext, useMemo, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { NotebookOutputWrapContext } from './notebookOutputContext'

const maxVisibleLines = 48
const maxVisibleChars = 5000

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
  hideKindLabel = false,
  kind,
  text,
  tone = 'normal'
}: {
  hideKindLabel?: boolean
  kind: string
  text: string
  tone?: 'normal' | 'error'
}): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)
  const wrapText = useContext(NotebookOutputWrapContext)
  const folded = useMemo(() => foldedOutput(text), [text])
  const displayText = folded.isFoldable && !isExpanded ? folded.previewText : text
  const kindLabel = outputKindLabel(kind)
  // "text/plain" and ordinary stdout are the default, unremarkable cases.
  // Keep labels only where they distinguish the output, such as stderr,
  // errors, JSON/CSV/LaTeX rendered as text, and fallback mimes.
  const showKindLabel = !hideKindLabel && kind !== 'text/plain' && kind !== 'stream:stdout'

  return (
    <Box
      data-phi-notebook-output-pre="true"
      data-phi-notebook-output-folded={folded.isFoldable && !isExpanded ? 'true' : undefined}
      data-phi-notebook-output-expanded={folded.isFoldable && isExpanded ? 'true' : undefined}
      data-phi-notebook-output-wrap={wrapText ? 'true' : 'false'}
      sx={{
        minWidth: 0,
        position: 'relative',
        width: '100%'
      }}
    >
      {showKindLabel ? (
        <Box sx={{ mb: 0.45 }}>
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
