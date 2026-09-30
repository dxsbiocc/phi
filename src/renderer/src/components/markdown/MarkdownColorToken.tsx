import { Box, Tooltip } from '@mui/material'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { MarkdownColorToken } from '../../lib/markdownColors'

const inlineCodeSx = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.85em',
  px: 0.6,
  py: 0.2,
  borderRadius: 1,
  bgcolor: 'rgba(148, 163, 184, 0.15)'
} as const

export function InlineCodeShell({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Box component="code" sx={inlineCodeSx}>
      {children}
    </Box>
  )
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

export function ColorCode({ color }: { color: string }): React.JSX.Element {
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
      <InlineCodeShell>{color}</InlineCodeShell>
    </Box>
  )
}

export function ColorPalette({ colors }: { colors: string[] }): React.JSX.Element {
  const [copiedColor, setCopiedColor] = useState<string | null>(null)

  useEffect(() => {
    if (!copiedColor) return
    const timeout = window.setTimeout(() => setCopiedColor(null), 1800)
    return () => window.clearTimeout(timeout)
  }, [copiedColor])

  async function copyColor(color: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(color)
      setCopiedColor(color)
    } catch {
      // Clipboard permissions can vary by host; leave the color visible for manual copying.
    }
  }

  return (
    <Box
      component="span"
      data-phi-slot="markdown-color-palette"
      sx={{
        display: 'flex',
        alignItems: 'center',
        maxWidth: '100%',
        width: 'max-content',
        overflowX: 'auto',
        pt: 2,
        pb: 2,
        pr: 2,
        my: 0.5,
        '& .phi-color-swatch:hover, & .phi-color-swatch:focus-visible': {
          transform: 'scale(1.4)',
          zIndex: 3
        },
        '& .phi-color-swatch:hover + .phi-color-swatch, & .phi-color-swatch:has(+ .phi-color-swatch:hover)':
          {
            transform: 'scale(1.12)',
            zIndex: 2
          },
        '@media (prefers-reduced-motion: reduce)': {
          '& .phi-color-swatch': { transition: 'none' }
        }
      }}
    >
      {colors.map((color, index) => (
        <Tooltip
          key={`${color}-${index}`}
          placement="top"
          title={copiedColor === color ? `已复制 ${color}` : color}
          slotProps={{
            tooltip: {
              sx: {
                bgcolor: 'background.paper',
                color: 'text.primary',
                border: 1,
                borderColor: 'divider',
                borderRadius: 1.5,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                boxShadow: 2
              }
            }
          }}
        >
          <Box
            component="button"
            type="button"
            className="phi-color-swatch"
            data-color={color}
            aria-label={`复制颜色 ${color}`}
            onClick={() => void copyColor(color)}
            sx={{
              appearance: 'none',
              position: 'relative',
              flexShrink: 0,
              width: 56,
              height: 72,
              ml: index === 0 ? 0 : -1,
              p: 0,
              border: 1,
              borderColor: 'divider',
              borderRadius: 1.5,
              cursor: 'pointer',
              boxShadow: 1,
              transition: 'transform 220ms cubic-bezier(0.175, 0.885, 0.32, 1.1)',
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
            }}
            style={{ backgroundColor: color }}
          />
        </Tooltip>
      ))}
    </Box>
  )
}

export function MarkdownColorTokenView({
  token
}: {
  token: MarkdownColorToken
}): React.JSX.Element {
  if (token.kind === 'color') return <ColorCode color={token.color} />
  if (token.kind === 'palette') return <ColorPalette colors={token.colors} />
  return <Fragment>{token.text}</Fragment>
}
