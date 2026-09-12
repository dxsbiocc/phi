import ReactMarkdown from 'react-markdown'
import { Box, Stack } from '@mui/material'
import { alpha } from '@mui/material/styles'
import remarkGfm from 'remark-gfm'
import { plainMarkdownInlineText, type NotebookOutlineItem } from '../lib/notebookViewModel'
import {
  notebookFloatingActionInset,
  notebookFloatingActionRailClearance
} from './NotebookFloatingActions'

const macTitlebarHeight = 44

function NotebookOutlineTitle({ item }: { item: NotebookOutlineItem }): React.JSX.Element {
  return (
    <Box
      component="span"
      data-phi-notebook-outline-title="rendered-markdown"
      sx={{
        display: 'block',
        minWidth: 0,
        fontSize: item.level === 1 ? '0.9rem' : '0.84rem',
        fontWeight: item.level <= 2 ? 700 : 500,
        lineHeight: 1.35,
        '& code': {
          px: 0.45,
          py: 0.1,
          borderRadius: 0.75,
          bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08),
          fontFamily: 'var(--font-mono)',
          fontSize: '0.9em'
        },
        '& strong': {
          fontWeight: 800
        },
        '& a': {
          color: 'inherit',
          textDecorationColor: 'currentColor',
          textUnderlineOffset: 2
        }
      }}
    >
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <>{children}</>,
          code: ({ children }) => <Box component="code">{children}</Box>,
          a: ({ children }) => <Box component="span">{children}</Box>,
          img: ({ alt }) => <Box component="span">{alt}</Box>
        }}
      >
        {item.title}
      </ReactMarkdown>
    </Box>
  )
}

export default function NotebookScrollProgressRail({
  outline,
  activeId,
  onSelect
}: {
  outline: NotebookOutlineItem[]
  activeId: string | null
  onSelect: (item: NotebookOutlineItem) => void
}): React.JSX.Element | null {
  if (outline.length === 0) return null

  return (
    <Box
      data-phi-notebook-outline="true"
      aria-label="Notebook document outline"
      sx={{
        position: 'absolute',
        top: `${macTitlebarHeight + 72}px`,
        bottom: `${notebookFloatingActionInset + notebookFloatingActionRailClearance}px`,
        right: 7,
        zIndex: 4,
        display: 'flex',
        alignItems: 'center',
        pointerEvents: 'auto',
        '&:hover .notebook-outline-popover': {
          opacity: 1,
          pointerEvents: 'auto',
          transform: 'translate(0, -50%)'
        }
      }}
    >
      <Stack spacing={1.05} data-phi-notebook-outline-markers="true" sx={{ alignItems: 'center' }}>
        {outline.map((item) => {
          const active = item.id === activeId
          const plainTitle = plainMarkdownInlineText(item.title)
          return (
            <Box
              key={item.id}
              component="button"
              type="button"
              aria-label={`跳转到 ${plainTitle}`}
              title={plainTitle}
              data-phi-notebook-scroll-marker={active ? 'active' : 'idle'}
              data-phi-notebook-outline-marker="true"
              data-phi-notebook-outline-level={item.level}
              onClick={() => onSelect(item)}
              sx={{
                width: active ? 3 : 2,
                height: active ? 18 : 12,
                p: 0,
                border: 0,
                borderRadius: 999,
                bgcolor: active ? 'text.primary' : 'text.disabled',
                opacity: active ? 1 : 0.72,
                cursor: 'pointer',
                transition: 'background-color 120ms ease, opacity 120ms ease',
                '&:hover': {
                  opacity: 1,
                  bgcolor: 'text.primary'
                },
                '&:focus-visible': {
                  outline: (theme) => `2px solid ${theme.palette.primary.main}`,
                  outlineOffset: 2
                }
              }}
            />
          )
        })}
      </Stack>
      <Box
        aria-hidden="true"
        data-phi-notebook-outline-hover-bridge="true"
        sx={{
          position: 'absolute',
          top: '50%',
          right: 18,
          width: 18,
          height: 'min(520px, calc(100vh - 96px))',
          transform: 'translateY(-50%)'
        }}
      />
      <Box
        className="notebook-outline-popover"
        data-phi-notebook-outline-popover="true"
        sx={{
          position: 'absolute',
          top: '50%',
          right: 28,
          width: 320,
          maxWidth: 'min(320px, calc(100vw - 96px))',
          maxHeight: 'min(520px, calc(100vh - 96px))',
          overflowY: 'auto',
          p: 1,
          border: 1,
          borderColor: 'divider',
          borderRadius: 2,
          bgcolor: 'background.paper',
          boxShadow: 4,
          opacity: 0,
          pointerEvents: 'none',
          transform: 'translate(0, -50%)',
          transition: 'opacity 130ms ease, transform 130ms ease'
        }}
      >
        <Stack spacing={0.25}>
          {outline.map((item) => {
            const active = item.id === activeId
            const plainTitle = plainMarkdownInlineText(item.title)
            return (
              <Box
                key={item.id}
                component="div"
                role="button"
                tabIndex={0}
                aria-label={`跳转到 ${plainTitle}`}
                title={plainTitle}
                data-phi-notebook-outline-item="true"
                data-phi-notebook-outline-active={active ? 'true' : 'false'}
                data-phi-notebook-outline-level={item.level}
                onClick={() => onSelect(item)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onSelect(item)
                }}
                sx={{
                  width: '100%',
                  minHeight: 30,
                  border: 0,
                  borderRadius: 1,
                  px: 1,
                  py: 0.55,
                  pl: 1 + Math.max(0, item.level - 1) * 1.35,
                  bgcolor: active ? 'action.selected' : 'transparent',
                  color: active ? 'primary.main' : 'text.primary',
                  cursor: 'pointer',
                  font: 'inherit',
                  textAlign: 'left',
                  lineHeight: 1.35,
                  overflowWrap: 'anywhere',
                  '&:hover': {
                    bgcolor: 'action.hover',
                    color: 'primary.main'
                  },
                  '&:focus-visible': {
                    outline: (theme) => `2px solid ${theme.palette.primary.main}`,
                    outlineOffset: 1
                  }
                }}
              >
                <NotebookOutlineTitle item={item} />
              </Box>
            )
          })}
        </Stack>
      </Box>
    </Box>
  )
}
