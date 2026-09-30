import type { MouseEvent } from 'react'
import { Box, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { PhiIcons, fileIconForPath } from '../../../icons'
import { notebookTabLabel, type NotebookListEntry } from '../lib/notebookViewModel'

const CloseIcon = PhiIcons.action.close
const NotebookIcon = PhiIcons.file.jupyter
const macTitlebarHeight = 44

export function NotebookHeader({
  activeNotebookPath,
  notebooks,
  hideNotebookTabs = false,
  onSelectNotebook,
  onCloseNotebook
}: {
  activeNotebookPath: string
  notebooks: NotebookListEntry[]
  hideNotebookTabs?: boolean
  onSelectNotebook?: (notebook: NotebookListEntry) => void
  onCloseNotebook?: (notebook: NotebookListEntry) => void
}): React.JSX.Element {
  if (hideNotebookTabs) {
    return <Box data-phi-notebook-file-tabs-hidden="true" sx={{ display: 'none' }} />
  }

  return (
    <Box
      sx={{
        height: macTitlebarHeight,
        flexShrink: 0,
        borderBottom: 1,
        borderColor: 'divider',
        px: 1.5,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        WebkitAppRegion: 'drag'
      }}
    >
      <NotebookFileTabs
        activeNotebookPath={activeNotebookPath}
        notebooks={notebooks}
        onSelectNotebook={onSelectNotebook}
        onCloseNotebook={onCloseNotebook}
      />
    </Box>
  )
}

function NotebookFileTabs({
  activeNotebookPath,
  notebooks,
  onSelectNotebook,
  onCloseNotebook
}: {
  activeNotebookPath: string
  notebooks: NotebookListEntry[]
  onSelectNotebook?: (notebook: NotebookListEntry) => void
  onCloseNotebook?: (notebook: NotebookListEntry) => void
}): React.JSX.Element {
  const hasActiveNotebook = activeNotebookPath !== 'No notebook selected'
  const tabs =
    notebooks.length > 0
      ? notebooks
      : hasActiveNotebook
        ? [
            {
              id: activeNotebookPath,
              path: activeNotebookPath,
              name: notebookTabLabel(activeNotebookPath),
              status: ''
            }
          ]
        : []

  if (tabs.length === 0) {
    return (
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <NotebookIcon fontSize="small" sx={{ color: 'primary.main' }} />
        <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700 }}>
          No notebook selected
        </Typography>
      </Box>
    )
  }

  return (
    <Box
      role="tablist"
      aria-label="Open notebooks"
      data-phi-notebook-file-tabs="true"
      sx={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.55,
        overflowX: 'auto',
        alignSelf: 'stretch',
        py: 0.65,
        WebkitAppRegion: 'no-drag',
        scrollbarWidth: 'none',
        '&::-webkit-scrollbar': { display: 'none' }
      }}
    >
      {tabs.map((notebook) => {
        const selected = notebook.path === activeNotebookPath
        const notebookIcon = fileIconForPath(notebook.path)
        const NotebookFileIcon = notebookIcon.Icon
        return (
          <Box
            key={notebook.id}
            component="div"
            role="tab"
            tabIndex={0}
            aria-selected={selected}
            data-phi-notebook-file-tab={selected ? 'active' : 'inactive'}
            data-phi-notebook-file-tab-size="compact"
            title={notebook.path}
            onClick={() => {
              if (!selected) onSelectNotebook?.(notebook)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              if (!selected) onSelectNotebook?.(notebook)
            }}
            sx={{
              border: 1,
              borderColor: selected
                ? (theme) => alpha(theme.palette.primary.main, 0.5)
                : (theme) => alpha(theme.palette.text.primary, 0.12),
              borderRadius: '999px',
              bgcolor: selected
                ? (theme) =>
                    alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.1)
                : (theme) => alpha(theme.palette.background.paper, 0.56),
              color: selected ? 'text.primary' : 'text.secondary',
              cursor: selected ? 'default' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 0.4,
              flex: '0 0 156px',
              width: 156,
              minWidth: 118,
              maxWidth: 156,
              height: 32,
              px: 0.6,
              pl: 1,
              font: 'inherit',
              textAlign: 'left',
              lineHeight: 1,
              '&:hover': {
                bgcolor: selected
                  ? (theme) =>
                      alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.24 : 0.14)
                  : (theme) => alpha(theme.palette.action.hover, 0.68),
                color: 'text.primary'
              },
              '&:hover .notebook-tab-close, &:focus-within .notebook-tab-close': {
                opacity: 1
              }
            }}
          >
            <NotebookFileIcon
              data-phi-notebook-file-tab-icon={notebookIcon.materialIconName}
              fontSize="small"
              sx={{
                flexShrink: 0,
                alignSelf: 'center',
                color: notebookIcon.color
              }}
            />
            <Typography
              component="span"
              noWrap
              sx={{
                flex: 1,
                minWidth: 0,
                fontFamily: 'var(--font-mono)',
                fontSize: '0.78rem',
                fontWeight: selected ? 800 : 650,
                lineHeight: '18px'
              }}
            >
              {notebook.name || notebookTabLabel(notebook.path)}
            </Typography>
            {onCloseNotebook ? (
              <Box
                className="notebook-tab-close"
                component="span"
                role="button"
                aria-label={`关闭 ${notebook.name || notebookTabLabel(notebook.path)}`}
                data-phi-notebook-file-tab-close="true"
                tabIndex={0}
                onClick={(event: MouseEvent<HTMLElement>) => {
                  event.stopPropagation()
                  onCloseNotebook(notebook)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  event.stopPropagation()
                  onCloseNotebook(notebook)
                }}
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  width: 17,
                  height: 17,
                  ml: 'auto',
                  borderRadius: '50%',
                  alignSelf: 'center',
                  color: 'text.disabled',
                  opacity: selected ? 0.72 : 0,
                  transition: 'opacity 120ms ease, background-color 120ms ease, color 120ms ease',
                  '&:hover': {
                    bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08),
                    color: 'text.primary'
                  }
                }}
              >
                <CloseIcon sx={{ fontSize: 14 }} />
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}
