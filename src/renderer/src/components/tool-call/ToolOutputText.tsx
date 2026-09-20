import { Box, Typography } from '@mui/material'
import { useMemo, type ReactNode } from 'react'
import { tokenizeLocalPaths } from '../../lib/localPaths'

function LocalPathOutputButton({
  text,
  absolutePath
}: {
  text: string
  absolutePath: string
}): ReactNode {
  return (
    <Box
      component="button"
      type="button"
      title={absolutePath}
      onClick={() => {
        void window.api.revealPath(absolutePath).catch((error) => {
          console.error('Failed to reveal tool output path:', error)
        })
      }}
      sx={{
        display: 'inline',
        p: 0,
        m: 0,
        border: 0,
        bgcolor: 'transparent',
        color: 'primary.light',
        font: 'inherit',
        fontFamily: 'inherit',
        textDecoration: 'underline',
        textDecorationThickness: '1px',
        textUnderlineOffset: '2px',
        cursor: 'pointer',
        overflowWrap: 'anywhere',
        '&:hover': { color: 'primary.main' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', borderRadius: 0.5 }
      }}
    >
      {text}
    </Box>
  )
}

function LocalPathOutputText({ text, cwd }: { text: string; cwd?: string }): ReactNode {
  return tokenizeLocalPaths(text, cwd ?? '').map((token, index) =>
    token.kind === 'path' ? (
      <LocalPathOutputButton
        key={`${token.absolutePath}-${index}`}
        text={token.text}
        absolutePath={token.absolutePath}
      />
    ) : (
      <span key={index}>{token.text}</span>
    )
  )
}

export function DiffAwareOutput({ text, cwd }: { text: string; cwd?: string }): ReactNode {
  const lines = useMemo(() => text.split('\n'), [text])
  const looksLikeDiff = useMemo(
    () => lines.some((line) => /^[+-]{1}[^+-]/.test(line) || /^@@ /.test(line)),
    [lines]
  )

  if (!looksLikeDiff) {
    return (
      <Typography
        component="pre"
        variant="body2"
        sx={{
          m: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8rem',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere'
        }}
      >
        <LocalPathOutputText text={text} cwd={cwd} />
      </Typography>
    )
  }

  return (
    <Box component="pre" sx={{ m: 0, fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
      {lines.map((line, index) => {
        const color = line.startsWith('+')
          ? 'success.main'
          : line.startsWith('-')
            ? 'error.main'
            : line.startsWith('@@')
              ? 'info.main'
              : 'text.secondary'
        return (
          <Typography
            key={index}
            component="div"
            variant="body2"
            sx={{
              fontFamily: 'inherit',
              fontSize: 'inherit',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              color
            }}
          >
            {line || ' '}
          </Typography>
        )
      })}
    </Box>
  )
}
