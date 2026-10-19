import { Badge, Box, IconButton, Tooltip } from '@mui/material'
import { alpha, type SxProps, type Theme } from '@mui/material/styles'
import { GoGlobe, GoStack, GoSync, GoTerminal } from 'react-icons/go'

import { useActiveBackgroundJobCount } from '../../features/jobs/hooks/useBackgroundJobsData'
import { appCopy } from '../../lib/appCopy'
import { useUiLanguage } from '../../lib/i18n'
import type { WorkspaceSidePanelMode } from '../../lib/workspaceSidePanelMode'

/** Shared with App.tsx so the titlebar offsets stay in sync with the controls below. */
export const titlebarChromeIconButtonSize = 28
const RefreshIcon = GoSync

export function TopRightControls({
  showSidePanelRefresh,
  sidePanelRefreshDisabled,
  activePanels,
  showSidePanelButtons,
  onRefreshSidePanel,
  onTogglePanel
}: {
  showSidePanelRefresh: boolean
  sidePanelRefreshDisabled: boolean
  activePanels: readonly WorkspaceSidePanelMode[]
  showSidePanelButtons: boolean
  onRefreshSidePanel: () => void
  onTogglePanel: (mode: WorkspaceSidePanelMode) => void
}): React.JSX.Element | null {
  useUiLanguage()
  const runningBackgroundJobs = useActiveBackgroundJobCount()
  const backgroundJobsLabel =
    runningBackgroundJobs > 0 ? appCopy.jobsRunning(runningBackgroundJobs) : appCopy.backgroundJobs
  if (!showSidePanelRefresh && !showSidePanelButtons) return null

  const buttonSx = {
    width: titlebarChromeIconButtonSize,
    height: titlebarChromeIconButtonSize,
    borderRadius: 1.5,
    color: 'text.secondary',
    pointerEvents: 'auto',
    WebkitAppRegion: 'no-drag',
    '&:hover': {
      bgcolor: 'action.hover',
      color: 'text.primary'
    },
    '&.Mui-disabled': {
      color: 'text.disabled'
    }
  } as const
  const panelButtonSx = (active: boolean): SxProps<Theme> => ({
    ...buttonSx,
    color: active ? 'primary.main' : 'text.secondary',
    '&:hover': {
      bgcolor: 'action.hover',
      color: active ? 'primary.main' : 'text.primary'
    },
    '& svg': { color: 'inherit', display: 'block' }
  })
  const runningJobsButtonSx: SxProps<Theme> = {
    ...buttonSx,
    color: 'info.main',
    bgcolor: (theme) => alpha(theme.palette.info.main, 0.12),
    '&:hover': {
      color: 'info.main',
      bgcolor: (theme) => alpha(theme.palette.info.main, 0.2)
    },
    '& svg': { color: 'inherit', display: 'block' }
  }

  return (
    <Box
      data-phi-top-right-controls="workspace"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexShrink: 0,
        gap: 0.5,
        WebkitAppRegion: 'no-drag'
      }}
    >
      {showSidePanelRefresh ? (
        <Tooltip title={appCopy.refreshFiles}>
          <span>
            <IconButton
              data-phi-workspace-side-panel-refresh-button="true"
              size="small"
              aria-label={appCopy.refreshFiles}
              disabled={sidePanelRefreshDisabled}
              onClick={onRefreshSidePanel}
              sx={buttonSx}
            >
              <RefreshIcon size={19} />
            </IconButton>
          </span>
        </Tooltip>
      ) : null}
      {showSidePanelButtons ? (
        <Tooltip title={backgroundJobsLabel}>
          <IconButton
            data-phi-background-jobs-toggle-button="true"
            data-phi-background-jobs-running-count={runningBackgroundJobs}
            data-phi-workspace-panel-toggle="jobs"
            size="small"
            aria-label={backgroundJobsLabel}
            aria-pressed={activePanels.includes('jobs')}
            onClick={() => onTogglePanel('jobs')}
            sx={
              runningBackgroundJobs > 0
                ? runningJobsButtonSx
                : panelButtonSx(activePanels.includes('jobs'))
            }
          >
            <Badge
              aria-hidden="true"
              badgeContent={runningBackgroundJobs}
              max={99}
              color="info"
              invisible={runningBackgroundJobs === 0}
              sx={{
                '& .MuiBadge-badge': {
                  height: 16,
                  minWidth: 16,
                  px: 0.4,
                  border: '2px solid',
                  borderColor: 'background.paper',
                  fontSize: '0.6rem',
                  fontWeight: 700,
                  transform: 'translate(40%, -40%)'
                },
                '& .MuiBadge-invisible': {
                  transform: 'scale(0) translate(40%, -40%)'
                }
              }}
            >
              <GoStack aria-hidden focusable="false" size={20} />
            </Badge>
          </IconButton>
        </Tooltip>
      ) : null}
      {showSidePanelButtons ? (
        <Tooltip title={appCopy.terminal}>
          <IconButton
            data-phi-terminal-toggle-button="true"
            data-phi-workspace-panel-toggle="terminal"
            size="small"
            aria-label={appCopy.terminal}
            aria-pressed={activePanels.includes('terminal')}
            onClick={() => onTogglePanel('terminal')}
            sx={panelButtonSx(activePanels.includes('terminal'))}
          >
            <GoTerminal aria-hidden focusable="false" size={20} />
          </IconButton>
        </Tooltip>
      ) : null}
      {showSidePanelButtons ? (
        <Tooltip title={appCopy.browser}>
          <IconButton
            data-phi-browser-toggle-button="true"
            data-phi-workspace-panel-toggle="browser"
            size="small"
            aria-label={appCopy.browser}
            aria-pressed={activePanels.includes('browser')}
            onClick={() => onTogglePanel('browser')}
            sx={panelButtonSx(activePanels.includes('browser'))}
          >
            <GoGlobe aria-hidden focusable="false" size={20} />
          </IconButton>
        </Tooltip>
      ) : null}
    </Box>
  )
}
