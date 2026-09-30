import { useState } from 'react'
import { Box, Fab, Menu, MenuItem, Tooltip, Typography } from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import { PhiIcons } from '../../../icons'
import { kernelOptionLabel, notebookKernelName, notebookLanguage } from '../lib/notebookViewModel'
import type { AnalysisKernelDiagnostics, AnalysisKernelSummary } from '../../../types'
import type { NotebookDocument } from '../../../../../shared/notebookDocument'

const NotebookIcon = PhiIcons.file.jupyter
const PythonIcon = PhiIcons.file.python
const RIcon = PhiIcons.file.r

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
  if (kind === 'python') return <PythonIcon fontSize="small" />
  if (kind === 'r') return <RIcon fontSize="small" />
  return <NotebookIcon fontSize="small" />
}

export function NotebookKernelControl({
  kernelLabel,
  kernelStatusLabel,
  kernelStatusColor,
  draftDocument,
  kernelDiagnostics,
  onKernelChange
}: {
  kernelLabel: string
  kernelStatusLabel: string
  kernelStatusColor: 'default' | 'primary' | 'success' | 'warning' | 'error'
  draftDocument?: NotebookDocument | null
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  onKernelChange?: (kernelName: string) => void | Promise<void>
}): React.JSX.Element | null {
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

  if (!draftDocument) return null

  return (
    <Box sx={{ display: 'inline-flex' }}>
      <Tooltip title={selectedKernelLabel} placement="left">
        <span>
          <Fab
            data-phi-notebook-kernel-control="true"
            data-phi-notebook-kernel-select="true"
            data-phi-notebook-kernel-menu-button="true"
            data-phi-notebook-kernel-icon={kernelIconKind}
            size="small"
            aria-label={kernelStatusLabel}
            title={selectedKernelLabel}
            aria-haspopup="menu"
            aria-expanded={kernelMenuOpen ? 'true' : undefined}
            disabled={!canSelectKernel}
            onClick={(event) => {
              setKernelMenuAnchor(event.currentTarget)
            }}
            sx={{
              width: 34,
              height: 34,
              minHeight: 34,
              bgcolor: 'background.paper',
              border: 1,
              borderColor: (theme: Theme) => alpha(theme.palette.text.primary, 0.14),
              boxShadow: (theme: Theme) => `0 2px 8px ${alpha(theme.palette.common.black, 0.16)}`,
              color: 'text.secondary',
              '&:hover': {
                bgcolor: 'background.paper',
                color: 'text.primary'
              },
              '&.Mui-disabled': {
                bgcolor: 'background.paper',
                color: 'text.disabled',
                opacity: 0.72
              }
            }}
          >
            <Box sx={{ position: 'relative', display: 'inline-flex' }}>
              <NotebookKernelIcon kind={kernelIconKind} />
              <Box
                data-phi-notebook-kernel-status-dot={kernelStatusColor}
                sx={{
                  position: 'absolute',
                  right: -3,
                  bottom: -3,
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
          </Fab>
        </span>
      </Tooltip>
      <Menu
        anchorEl={kernelMenuAnchor}
        open={kernelMenuOpen}
        onClose={closeKernelMenu}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              minWidth: 210,
              maxWidth: 320
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
    </Box>
  )
}
