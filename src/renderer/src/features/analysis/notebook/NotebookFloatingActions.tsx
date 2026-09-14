import { Fab, Stack, Tooltip } from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import { PhiIcons } from '../../../icons'
import { hasLiveNotebookSession } from '../lib/notebookSession'
import type { AnalysisNotebookFile, AnalysisNotebookSessionStatus } from '../../../types'

export const notebookFloatingActionInset = 28
export const notebookFloatingActionRailClearance = 96

export type NotebookFloatingActionAnchor = {
  right: number
  bottom: number
}

const SaveIcon = PhiIcons.action.save
const StopIcon = PhiIcons.action.stop
const FormatIcon = PhiIcons.action.format

export default function NotebookFloatingActions({
  hasDocument,
  isDirty,
  isOpening,
  isStartingNotebookSession,
  anchor,
  notebookFile,
  notebookSessionStatus,
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
  onSave?: () => void
  onFormat?: () => void | Promise<void>
  isFormatting?: boolean
  onStopNotebookSession?: (file: AnalysisNotebookFile) => void | Promise<void>
}): React.JSX.Element | null {
  const canDisconnectNotebookSession = Boolean(
    notebookFile && onStopNotebookSession && hasLiveNotebookSession(notebookSessionStatus)
  )

  if (!hasDocument && !canDisconnectNotebookSession) return null

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
        <Tooltip title={isFormatting ? '正在格式化 notebook' : '格式化 notebook'} placement="left">
          <span>
            <Fab
              data-phi-notebook-floating-action="format"
              size="small"
              aria-label="格式化 notebook"
              disabled={isOpening || isFormatting || !onFormat}
              onClick={() => {
                void onFormat?.()
              }}
              sx={fabSx}
            >
              <FormatIcon fontSize="small" />
            </Fab>
          </span>
        </Tooltip>
      ) : null}
      {hasDocument ? (
        <Tooltip title={isDirty ? '保存 notebook' : '已保存'} placement="left">
          <span>
            <Fab
              data-phi-notebook-save-state={isDirty ? 'unsaved' : 'saved'}
              data-phi-notebook-floating-action="save"
              size="small"
              aria-label="保存 notebook"
              disabled={!isDirty || isOpening}
              onClick={onSave}
              sx={{
                ...fabSx,
                bgcolor: isDirty ? 'warning.light' : 'background.paper',
                color: isDirty ? 'warning.dark' : 'text.secondary',
                '&:hover': {
                  bgcolor: isDirty ? 'warning.light' : 'background.paper',
                  color: isDirty ? 'warning.dark' : 'text.primary'
                },
                '&.Mui-disabled': {
                  bgcolor: isDirty ? 'warning.light' : 'background.paper',
                  color: isDirty ? 'warning.dark' : 'text.disabled',
                  opacity: 0.82
                }
              }}
            >
              <SaveIcon fontSize="small" />
            </Fab>
          </span>
        </Tooltip>
      ) : null}
      {canDisconnectNotebookSession ? (
        <Tooltip title="断开 kernel" placement="left">
          <span>
            <Fab
              data-phi-notebook-floating-action="disconnect-kernel"
              size="small"
              aria-label="断开 kernel"
              disabled={Boolean(isStartingNotebookSession)}
              onClick={() => {
                if (notebookFile) onStopNotebookSession?.(notebookFile)
              }}
              sx={{
                ...fabSx,
                color: 'warning.dark'
              }}
            >
              <StopIcon fontSize="small" />
            </Fab>
          </span>
        </Tooltip>
      ) : null}
    </Stack>
  )
}
