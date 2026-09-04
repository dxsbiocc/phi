import { Box, Divider, Link, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function CodeBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        my: 1,
        p: 1.5,
        borderRadius: 2,
        bgcolor: 'rgba(0, 0, 0, 0.35)',
        border: 1,
        borderColor: 'grey.800',
        overflowX: 'auto',
        maxWidth: '100%',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.82rem',
        lineHeight: 1.6
      }}
    >
      {children}
    </Box>
  )
}

function MarkdownContent({ text }: { text: string }): React.JSX.Element {
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
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <Typography variant="body1" sx={{ my: 1, fontSize: 'inherit', lineHeight: 'inherit' }}>
              {children}
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
              {children}
            </Typography>
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
              <Box
                component="code"
                sx={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.85em',
                  px: 0.6,
                  py: 0.2,
                  borderRadius: 1,
                  bgcolor: 'rgba(148, 163, 184, 0.15)'
                }}
              >
                {children}
              </Box>
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
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </Box>
  )
}

export default MarkdownContent
