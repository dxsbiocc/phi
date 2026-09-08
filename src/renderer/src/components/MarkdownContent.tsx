import { Box, Button, Divider, Link, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { Fragment, isValidElement, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PhiIcons } from '../icons'
import { tokenizeLocalPaths } from '../lib/localPaths'
import {
  normalizeHexColor,
  tokenizeMarkdownColors,
  type MarkdownColorToken
} from '../lib/markdownColors'

const ContentCopyIcon = PhiIcons.action.copy

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
  absolutePath
}: {
  text: string
  absolutePath: string
}): React.JSX.Element {
  return (
    <Box
      component="button"
      type="button"
      title={absolutePath}
      onClick={() => {
        void window.api.revealPath(absolutePath).catch((error) => {
          console.error('Failed to reveal local path:', error)
        })
      }}
      sx={{
        display: 'inline',
        minWidth: 0,
        p: 0,
        m: 0,
        border: 0,
        bgcolor: 'transparent',
        color: 'primary.light',
        font: 'inherit',
        fontFamily: 'var(--font-mono)',
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

function renderDecoratedText(text: string, cwd: string, keyPrefix: string): ReactNode[] {
  return tokenizeLocalPaths(text, cwd).flatMap((token, pathIndex) => {
    if (token.kind === 'path') {
      return [
        <LocalPathButton
          key={`${keyPrefix}-path-${pathIndex}-${token.absolutePath}`}
          text={token.text}
          absolutePath={token.absolutePath}
        />
      ]
    }

    return tokenizeMarkdownColors(token.text).map((colorToken, colorIndex) =>
      renderColorToken(colorToken, `${keyPrefix}-color-${pathIndex}-${colorIndex}`)
    )
  })
}

function renderInlineChildren(children: ReactNode, cwd: string): ReactNode {
  if (typeof children === 'string') {
    return renderDecoratedText(children, cwd, 'inline')
  }
  if (Array.isArray(children)) {
    return children.map((child, index) => (
      <Fragment key={index}>{renderInlineChildren(child, cwd)}</Fragment>
    ))
  }
  return children
}

function InlineCode({ children }: { children?: ReactNode }): React.JSX.Element {
  const codeText = textFromNode(children)
  const color = normalizeHexColor(codeText)
  if (color) return <ColorCode color={color} />

  return (
    <Box component="code" sx={inlineCodeSx}>
      {children}
    </Box>
  )
}

function MarkdownContent({ text, cwd = '' }: { text: string; cwd?: string }): React.JSX.Element {
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
              {renderInlineChildren(children, cwd)}
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
              {renderInlineChildren(children, cwd)}
            </Typography>
          ),
          strong: ({ children }) => (
            <Box component="strong" sx={{ fontWeight: 700 }}>
              {renderInlineChildren(children, cwd)}
            </Box>
          ),
          em: ({ children }) => (
            <Box component="em" sx={{ fontStyle: 'italic' }}>
              {renderInlineChildren(children, cwd)}
            </Box>
          ),
          a: ({ href, children }) => (
            <Link href={href} target="_blank" rel="noreferrer" sx={{ color: 'primary.light' }}>
              {children}
            </Link>
          ),
          hr: () => <Divider sx={{ my: 1.5 }} />,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ className, children }) =>
            className ? (
              <Box component="code" sx={{ fontFamily: 'var(--font-mono)', fontSize: 'inherit' }}>
                {children}
              </Box>
            ) : (
              <InlineCode>{children}</InlineCode>
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
              {renderInlineChildren(children, cwd)}
            </Box>
          ),
          td: ({ children }) => <Box component="td">{renderInlineChildren(children, cwd)}</Box>
        }}
      >
        {text}
      </ReactMarkdown>
    </Box>
  )
}

export default MarkdownContent
