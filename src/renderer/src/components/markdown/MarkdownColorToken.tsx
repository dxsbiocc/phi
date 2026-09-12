import { Box } from '@mui/material'
import { Fragment, type ReactNode } from 'react'
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

export function MarkdownColorTokenView({
  token
}: {
  token: MarkdownColorToken
}): React.JSX.Element {
  if (token.kind === 'color') return <ColorCode color={token.color} />
  if (token.kind === 'palette') return <ColorPalettePreview colors={token.colors} />
  return <Fragment>{token.text}</Fragment>
}
