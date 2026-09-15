import { useMemo } from 'react'
import { Box } from '@mui/material'
import { highlightLine, languageForPath, type SyntaxToken } from '../../../lib/syntaxHighlight'
import { syntaxTokenColor } from '../../../lib/syntaxTheme'
import type { FilePreview } from '../../../types'

const LARGE_CODE_PREVIEW_RENDER_LINE_LIMIT = 1200
const LARGE_CODE_PREVIEW_HIGHLIGHT_BYTES_LIMIT = 160000
const LARGE_CODE_PREVIEW_LINE_COUNT_LIMIT = 4000

function plainTokensForLine(line: string): SyntaxToken[] {
  return [{ kind: 'plain', value: line || ' ' }]
}

export function CodePreview({
  file
}: {
  file: Extract<FilePreview, { kind: 'text' }>
}): React.JSX.Element {
  const language = languageForPath(file.path)
  const lines = useMemo(
    () => (file.content.length > 0 ? file.content.split('\n') : ['']),
    [file.content]
  )
  const useLightweightPreview =
    file.truncated ||
    file.previewBytes > LARGE_CODE_PREVIEW_HIGHLIGHT_BYTES_LIMIT ||
    lines.length > LARGE_CODE_PREVIEW_LINE_COUNT_LIMIT
  const renderedLines = useMemo(
    () =>
      useLightweightPreview && lines.length > LARGE_CODE_PREVIEW_RENDER_LINE_LIMIT
        ? lines.slice(0, LARGE_CODE_PREVIEW_RENDER_LINE_LIMIT)
        : lines,
    [lines, useLightweightPreview]
  )
  const highlightedLines = useMemo(
    () =>
      renderedLines.map((line) => ({
        tokens: useLightweightPreview ? plainTokensForLine(line) : highlightLine(line, language)
      })),
    [language, renderedLines, useLightweightPreview]
  )
  const hiddenLineCount = lines.length - renderedLines.length

  return (
    <Box
      data-phi-syntax-language={language}
      data-phi-code-preview-mode={useLightweightPreview ? 'lightweight' : 'highlighted'}
      data-phi-code-preview-rendered-lines={renderedLines.length}
      data-phi-code-preview-total-lines={lines.length}
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: 'auto',
        bgcolor: 'background.default',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.82rem',
        lineHeight: 1.55
      }}
    >
      {highlightedLines.map(({ tokens }, index) => (
        <Box
          key={index}
          sx={{
            display: 'grid',
            gridTemplateColumns: '48px minmax(0, 1fr)',
            minWidth: 'max-content'
          }}
        >
          <Box
            component="span"
            sx={{
              color: 'text.disabled',
              textAlign: 'right',
              pr: 1.5,
              userSelect: 'none',
              borderRight: 1,
              borderColor: 'divider'
            }}
          >
            {index + 1}
          </Box>
          <Box
            component="code"
            sx={{
              display: 'block',
              whiteSpace: 'pre',
              px: 1.5,
              color: 'text.primary'
            }}
          >
            {tokens.map((token, tokenIndex) => (
              <Box
                key={`${index}-${tokenIndex}`}
                component="span"
                data-phi-syntax-token={token.kind}
                sx={{ color: (theme) => syntaxTokenColor(theme, token.kind) }}
              >
                {token.value}
              </Box>
            ))}
          </Box>
        </Box>
      ))}
      {useLightweightPreview ? (
        <Box
          data-phi-code-preview-optimized="true"
          sx={{
            borderTop: 1,
            borderColor: 'divider',
            color: 'text.secondary',
            px: 1.5,
            py: 1,
            pl: '60px',
            whiteSpace: 'normal'
          }}
        >
          大文件已使用轻量文本预览
          {hiddenLineCount > 0
            ? `，仅渲染前 ${renderedLines.length.toLocaleString('zh-CN')} 行（共 ${lines.length.toLocaleString('zh-CN')} 行）`
            : ''}
          。
        </Box>
      ) : null}
    </Box>
  )
}
