import { useState, type MouseEvent } from 'react'
import { Box, Button, Menu, MenuItem, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { PhiIcons, fileIconForPath } from '../../../icons'
import {
  kernelOptionLabel,
  notebookLanguage,
  notebookKernelName,
  notebookTabLabel,
  type NotebookListEntry
} from '../lib/notebookViewModel'
import type { AnalysisKernelDiagnostics, AnalysisKernelSummary } from '../../../types'
import type { NotebookDocument } from '../../../../../shared/notebookDocument'

const CloseIcon = PhiIcons.action.close
const ExpandIcon = PhiIcons.action.expand
const NotebookIcon = PhiIcons.file.jupyter
const PythonIcon = PhiIcons.file.python
const RIcon = PhiIcons.file.r
const macTitlebarHeight = 44

function normalizedKernelIconKind(value: string | null | undefined): 'python' | 'r' | null {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'python' || normalized.startsWith('python') || normalized === 'py') {
    return 'python'
  }
  if (normalized === 'r' || normalized === 'ir' || normalized.startsWith('r-')) return 'r'
  return null
}

function notebookKernelIconKind(
  kernel: AnalysisKernelSummary | undefined,
  document: NotebookDocument | null | undefined,
  fallbackLabel: string
): 'python' | 'r' | 'jupyter' {
  const candidates = kernel
    ? [kernel.language, kernel.rawLanguage, kernel.name, kernel.displayName, fallbackLabel]
    : [document ? notebookLanguage(document) : '', fallbackLabel]

  for (const candidate of candidates) {
    const iconKind = normalizedKernelIconKind(candidate)
    if (iconKind) return iconKind
  }
  return 'jupyter'
}

function NotebookKernelIcon({
  kind
}: {
  kind: ReturnType<typeof notebookKernelIconKind>
}): React.JSX.Element {
  if (kind === 'python') return <PythonIcon sx={{ fontSize: 14 }} />
  if (kind === 'r') return <RIcon sx={{ fontSize: 14 }} />
  return <NotebookIcon sx={{ fontSize: 14 }} />
}

export function NotebookHeader({
  activeNotebookPath,
  notebooks,
  hideNotebookTabs = false,
  kernelLabel,
  kernelStatusLabel,
  kernelStatusColor,
  draftDocument,
  kernelDiagnostics,
  onKernelChange,
  onSelectNotebook,
  onCloseNotebook
}: {
  activeNotebookPath: string
  notebooks: NotebookListEntry[]
  hideNotebookTabs?: boolean
  kernelLabel: string
  kernelStatusLabel: string
  kernelStatusColor: 'default' | 'primary' | 'success' | 'warning' | 'error'
  draftDocument?: NotebookDocument | null
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  onKernelChange?: (kernelName: string) => void | Promise<void>
  onSelectNotebook?: (notebook: NotebookListEntry) => void
  onCloseNotebook?: (notebook: NotebookListEntry) => void
}): React.JSX.Element {
  const kernelOptions = kernelDiagnostics?.kernels ?? []
  const selectedKernelName = draftDocument ? notebookKernelName(draftDocument) : ''
  const selectedKernel = kernelOptions.find((kernel) => kernel.name === selectedKernelName)
  const selectedKernelIsMissing = Boolean(
    selectedKernelName && !kernelOptions.some((kernel) => kernel.name === selectedKernelName)
  )
  const canSelectKernel = Boolean(draftDocument && onKernelChange && kernelOptions.length > 0)
  const [kernelMenuAnchor, setKernelMenuAnchor] = useState<HTMLElement | null>(null)
  const kernelMenuOpen = Boolean(kernelMenuAnchor)
  const selectedKernelLabel = selectedKernelIsMissing
    ? kernelLabel
    : selectedKernel
      ? kernelOptionLabel(selectedKernel)
      : selectedKernelName || 'Auto'
  const kernelIconKind = notebookKernelIconKind(selectedKernel, draftDocument, kernelLabel)
  const closeKernelMenu = (): void => setKernelMenuAnchor(null)
  const chooseKernel = (kernelName: string): void => {
    closeKernelMenu()
    if (kernelName === selectedKernelName) return
    void onKernelChange?.(kernelName)
  }
  return (
    <Box
      sx={{
        height: macTitlebarHeight,
        flexShrink: 0,
        borderBottom: 1,
        borderColor: 'divider',
        pl: 1.5,
        pr: 15,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        WebkitAppRegion: 'drag'
      }}
    >
      {hideNotebookTabs ? (
        <Box data-phi-notebook-file-tabs-hidden="true" sx={{ flex: 1, minWidth: 0 }} />
      ) : (
        <NotebookFileTabs
          activeNotebookPath={activeNotebookPath}
          notebooks={notebooks}
          onSelectNotebook={onSelectNotebook}
          onCloseNotebook={onCloseNotebook}
        />
      )}
      <Box
        sx={{
          display: { xs: 'none', md: 'flex' },
          alignItems: 'center',
          gap: 0.75,
          minWidth: 0,
          color: 'text.secondary',
          WebkitAppRegion: 'no-drag'
        }}
      >
        <Box
          aria-label={kernelStatusLabel}
          title={kernelStatusLabel}
          data-phi-notebook-kernel-icon={kernelIconKind}
          sx={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}
        >
          <NotebookKernelIcon kind={kernelIconKind} />
          <Box
            data-phi-notebook-kernel-status-dot={kernelStatusColor}
            sx={{
              position: 'absolute',
              right: -2,
              bottom: -2,
              width: 6,
              height: 6,
              borderRadius: '50%',
              border: 1,
              borderColor: 'background.paper',
              bgcolor:
                kernelStatusColor === 'default' ? 'text.disabled' : `${kernelStatusColor}.main`
            }}
          />
        </Box>
        {kernelOptions.length > 0 && draftDocument ? (
          <>
            <Button
              size="small"
              data-phi-notebook-kernel-select="true"
              data-phi-notebook-kernel-menu-button="true"
              aria-label="选择 notebook kernel"
              aria-haspopup="menu"
              aria-expanded={kernelMenuOpen ? 'true' : undefined}
              disabled={!canSelectKernel}
              endIcon={<ExpandIcon sx={{ fontSize: 16 }} />}
              onClick={(event) => {
                setKernelMenuAnchor(event.currentTarget)
              }}
              sx={{
                width: 170,
                maxWidth: '20vw',
                height: 24,
                minWidth: 0,
                px: 1,
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                bgcolor: (theme) => alpha(theme.palette.background.paper, 0.72),
                color: 'text.primary',
                justifyContent: 'space-between',
                textTransform: 'none',
                fontSize: '0.74rem',
                fontWeight: 600,
                WebkitAppRegion: 'no-drag',
                '& .MuiButton-endIcon': {
                  ml: 0.35,
                  mr: -0.2,
                  color: 'text.secondary'
                }
              }}
            >
              <Typography
                component="span"
                noWrap
                sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                {selectedKernelLabel}
              </Typography>
            </Button>
            <Menu
              anchorEl={kernelMenuAnchor}
              open={kernelMenuOpen}
              onClose={closeKernelMenu}
              slotProps={{
                paper: {
                  sx: {
                    minWidth: 210,
                    maxWidth: 320,
                    WebkitAppRegion: 'no-drag'
                  }
                }
              }}
            >
              {selectedKernelIsMissing ? (
                <MenuItem disabled selected dense>
                  {kernelLabel}
                </MenuItem>
              ) : null}
              {kernelOptions.map((kernel) => (
                <MenuItem
                  key={kernel.name}
                  dense
                  selected={kernel.name === selectedKernelName}
                  onClick={() => chooseKernel(kernel.name)}
                >
                  <Typography component="span" noWrap sx={{ fontSize: '0.82rem' }}>
                    {kernelOptionLabel(kernel)}
                  </Typography>
                </MenuItem>
              ))}
            </Menu>
          </>
        ) : (
          <Typography variant="caption" noWrap>
            {kernelLabel}
          </Typography>
        )}
      </Box>
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
