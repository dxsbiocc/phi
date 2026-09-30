import { useState } from 'react'
import {
  Fab,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import { PhiIcons } from '../../../icons'
import { hasLiveNotebookSession } from '../lib/notebookSession'
import type {
  AnalysisKernelDiagnostics,
  AnalysisNotebookFile,
  AnalysisNotebookSessionStatus
} from '../../../types'
import type { NotebookDocument } from '../../../../../shared/notebookDocument'
import { NotebookKernelControl } from './NotebookKernelControl'
import { notebookCommandLabel } from '../lib/notebookShortcuts'

export const notebookFloatingActionInset = 28
export const notebookFloatingActionSize = 34
export const notebookFloatingActionCenterInset =
  notebookFloatingActionInset + notebookFloatingActionSize / 2
export const notebookFloatingActionRailClearance = 96

export type NotebookFloatingActionAnchor = {
  right: number
  bottom: number
}

const SaveIcon = PhiIcons.action.save
const StopIcon = PhiIcons.action.stop
const FormatIcon = PhiIcons.action.format
const SettingsIcon = PhiIcons.nav.settings

export default function NotebookFloatingActions({
  hasDocument,
  isDirty,
  isOpening,
  isStartingNotebookSession,
  anchor,
  notebookFile,
  notebookSessionStatus,
  kernelLabel,
  kernelStatusLabel,
  kernelStatusColor,
  draftDocument,
  kernelDiagnostics,
  onKernelChange,
  onSave,
  onFormat,
  isFormatting = false,
  onStopNotebookSession
}: {
  hasDocument: boolean
  isDirty: boolean
  isOpening: boolean
  isStartingNotebookSession?: boolean
  anchor: NotebookFloatingActionAnchor
  notebookFile?: AnalysisNotebookFile | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  kernelLabel: string
  kernelStatusLabel: string
  kernelStatusColor: 'default' | 'primary' | 'success' | 'warning' | 'error'
  draftDocument?: NotebookDocument | null
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  onKernelChange?: (kernelName: string) => void | Promise<void>
  onSave?: () => void
  onFormat?: () => void | Promise<void>
  isFormatting?: boolean
  onStopNotebookSession?: (file: AnalysisNotebookFile) => void | Promise<void>
}): React.JSX.Element | null {
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | null>(null)
  const canDisconnectNotebookSession = Boolean(
    notebookFile && onStopNotebookSession && hasLiveNotebookSession(notebookSessionStatus)
  )

  if (!hasDocument) return null

  const fabSx = {
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
  } as const

  const closeSettingsMenu = (): void => setSettingsAnchor(null)

  return (
    <Stack
      data-phi-notebook-floating-actions="true"
      data-phi-notebook-floating-actions-position="fixed"
      data-phi-notebook-floating-actions-inset={`${notebookFloatingActionInset}px`}
      spacing={0.8}
      sx={{
        position: 'fixed',
        right: `${anchor.right}px`,
        bottom: `${anchor.bottom}px`,
        zIndex: 5,
        alignItems: 'center'
      }}
    >
      {hasDocument ? (
        <NotebookKernelControl
          kernelLabel={kernelLabel}
          kernelStatusLabel={kernelStatusLabel}
          kernelStatusColor={kernelStatusColor}
          draftDocument={draftDocument}
          kernelDiagnostics={kernelDiagnostics}
          onKernelChange={onKernelChange}
        />
      ) : null}
      {hasDocument ? (
        <>
          <Tooltip title={isDirty ? '有未保存的修改' : 'Notebook 设置'} placement="left">
            <span>
              <Fab
                data-phi-notebook-save-state={isDirty ? 'unsaved' : 'saved'}
                data-phi-notebook-floating-action="settings"
                size="small"
                aria-label="Notebook 设置"
                aria-haspopup="menu"
                aria-expanded={settingsAnchor ? 'true' : undefined}
                onClick={(event) => setSettingsAnchor(event.currentTarget)}
                sx={{
                  ...fabSx,
                  bgcolor: isDirty ? 'warning.light' : 'background.paper',
                  color: isDirty ? 'warning.dark' : 'text.secondary',
                  '&:hover': {
                    bgcolor: isDirty ? 'warning.light' : 'background.paper',
                    color: isDirty ? 'warning.dark' : 'text.primary'
                  }
                }}
              >
                <SettingsIcon fontSize="small" />
              </Fab>
            </span>
          </Tooltip>
          <Menu
            anchorEl={settingsAnchor}
            open={Boolean(settingsAnchor)}
            onClose={closeSettingsMenu}
            anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
            transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            slotProps={{ paper: { sx: { minWidth: 180 } } }}
          >
            <MenuItem
              data-phi-notebook-floating-action="save"
              disabled={!isDirty || isOpening}
              onClick={() => {
                closeSettingsMenu()
                onSave?.()
              }}
            >
              <ListItemIcon>
                <SaveIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary={isDirty ? '保存 notebook' : '已保存'} />
              <Typography variant="caption" color="text.secondary" sx={{ pl: 2 }}>
                {notebookCommandLabel('save')}
              </Typography>
            </MenuItem>
            <MenuItem
              data-phi-notebook-floating-action="format"
              disabled={isOpening || isFormatting || !onFormat}
              onClick={() => {
                closeSettingsMenu()
                void onFormat?.()
              }}
            >
              <ListItemIcon>
                <FormatIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary={isFormatting ? '正在格式化 notebook' : '格式化 notebook'} />
              <Typography variant="caption" color="text.secondary" sx={{ pl: 2 }}>
                {notebookCommandLabel('format')}
              </Typography>
            </MenuItem>
            <MenuItem
              data-phi-notebook-floating-action="disconnect-kernel"
              disabled={!canDisconnectNotebookSession || Boolean(isStartingNotebookSession)}
              onClick={() => {
                closeSettingsMenu()
                if (notebookFile) void onStopNotebookSession?.(notebookFile)
              }}
            >
              <ListItemIcon>
                <StopIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="断开 kernel" />
            </MenuItem>
          </Menu>
        </>
      ) : null}
    </Stack>
  )
}
