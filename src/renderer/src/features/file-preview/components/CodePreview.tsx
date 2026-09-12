import { Box } from '@mui/material'
import { highlightLine, languageForPath } from '../../../lib/syntaxHighlight'
import { syntaxTokenColor } from '../../../lib/syntaxTheme'
import type { FilePreview } from '../../../types'

export function CodePreview({
  file
}: {
  file: Extract<FilePreview, { kind: 'text' }>
}): React.JSX.Element {
  const lines = file.content.length > 0 ? file.content.split('\n') : ['']
  const language = languageForPath(file.path)

  return (
    <Box
      data-phi-syntax-language={language}
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
      {lines.map((line, index) => (
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
            {highlightLine(line, language).map((token, tokenIndex) => (
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
    </Box>
  )
}
