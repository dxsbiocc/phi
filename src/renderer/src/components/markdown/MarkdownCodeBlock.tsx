import { Box, Button, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { Fragment, isValidElement, useContext, useMemo, useState, type ReactNode } from 'react'
import { PhiIcons } from '../../icons'
import { useUiLanguage } from '../../lib/i18n'
import { syntaxLanguageForMarkdownCode } from '../../lib/markdownCodeLanguage'
import { textFromNode } from '../../lib/markdownText'
import { highlightLine, type SyntaxLanguage } from '../../lib/syntaxHighlight'
import { syntaxTokenColor } from '../../lib/syntaxTheme'
import { markdownCopy } from './markdownUiCopy'
import { MarkdownCodeActionsContext } from './MarkdownCodeActionsContext'

const ContentCopyIcon = PhiIcons.action.copy

function languageFromCodeChild(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children
  if (!isValidElement<{ className?: string }>(child)) return null

  const match = /language-([^\s]+)/.exec(child.props.className ?? '')
  return match?.[1] ?? null
}

function HighlightedCodeContent({
  codeText,
  language
}: {
  codeText: string
  language: SyntaxLanguage
}): React.JSX.Element {
  useUiLanguage()
  const lines = useMemo(
    () => codeText.split('\n').map((line) => highlightLine(line, language)),
    [codeText, language]
  )

  return (
    <Box
      component="code"
      data-phi-markdown-code={language === 'plain' ? 'plain' : 'highlighted'}
      data-phi-markdown-code-language={language}
      sx={{ color: 'text.primary' }}
    >
      {lines.map((tokens, lineIndex) => (
        <Fragment key={lineIndex}>
          {tokens.map((token, tokenIndex) => (
            <Box
              key={`${lineIndex}-${tokenIndex}`}
              component="span"
              data-phi-syntax-token={token.kind}
              sx={{ color: (theme) => syntaxTokenColor(theme, token.kind) }}
            >
              {token.value}
            </Box>
          ))}
          {lineIndex < lines.length - 1 ? '\n' : null}
        </Fragment>
      ))}
    </Box>
  )
}

function CodeBlockHeader({
  languageLabel,
  copied,
  onCopy,
  action
}: {
  languageLabel: string
  copied: boolean
  onCopy: () => void
  action: ReactNode
}): React.JSX.Element {
  return (
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
        title={languageLabel}
      >
        {languageLabel}
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 0.5 }}>
        {action}
        <Button
          size="small"
          variant="text"
          startIcon={<ContentCopyIcon sx={{ fontSize: 15 }} />}
          onClick={onCopy}
          sx={{ minHeight: 28, textTransform: 'none', color: 'text.secondary' }}
        >
          {copied ? markdownCopy.copied : markdownCopy.copy}
        </Button>
      </Box>
    </Box>
  )
}

export function MarkdownCodeBlock({
  children,
  allowActions = false
}: {
  children?: ReactNode
  allowActions?: boolean
}): React.JSX.Element {
  useUiLanguage()
  const renderAction = useContext(MarkdownCodeActionsContext)
  const [copied, setCopied] = useState(false)
  const language = languageFromCodeChild(children)
  const languageLabel = language ?? markdownCopy.code
  const syntaxLanguage = syntaxLanguageForMarkdownCode(language)
  const codeText = textFromNode(children).replace(/\n$/, '')

  const copyCode = (): void => {
    void navigator.clipboard.writeText(codeText).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      },
      (error) => {
        console.error('Failed to copy code block:', error)
      }
    )
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
      <CodeBlockHeader
        languageLabel={languageLabel}
        copied={copied}
        onCopy={copyCode}
        action={allowActions && language && codeText.trim() && renderAction?.(language, codeText)}
      />
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
        <HighlightedCodeContent codeText={codeText} language={syntaxLanguage} />
      </Box>
    </Box>
  )
}
