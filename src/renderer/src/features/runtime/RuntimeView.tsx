import { runtimeUi } from './lib/runtimeUi'
import { groupRuntimeStatuses } from './lib/runtimeGroups'
import { useUiLanguage } from '../../lib/i18n'
import {
  Box,
  Chip,
  IconButton,
  Link,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import { GoSync } from 'react-icons/go'
import { PhiIcons } from '../../icons'
import { isListedNotebookKernel } from '../analysis/lib/notebookSession'
import type {
  AnalysisJupyterRuntimeStatus,
  AnalysisNotebookKernelState,
  JupyterServerState
} from '../../types'

export interface RuntimeSidebarProps {
  projectCwd: string
  runtimeStatus: AnalysisJupyterRuntimeStatus | null
  additionalRuntimeStatuses?: AnalysisJupyterRuntimeStatus[]
  currentRuntimeKind?: 'local' | 'ssh'
  currentServerLabel?: string
  isLoading?: boolean
  onOpenNotebook?: (notebookPath: string) => void
  closingNotebookPath?: string | null
  onRefresh: () => void
  onStartJupyter: (cwd: string) => void
  /** Opens the newest remote Jupyter startup job in the background jobs panel. */
  onOpenStartLog?: () => void
  onStopJupyter: (cwd: string, options?: { abandonUnconfirmed?: boolean }) => void
  onStopNotebookKernel: (notebookPath: string) => void
}

const RefreshIcon = GoSync
const RunIcon = PhiIcons.action.run
const StopIcon = PhiIcons.action.stop
const NotebookIcon = PhiIcons.file.jupyter
const PythonIcon = PhiIcons.file.python
const RIcon = PhiIcons.file.r
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const macTitlebarHeight = 44
const runtimeSidebarSurfaceSx = {
  width: '100%',
  minWidth: 0,
  flexShrink: 0,
  backgroundColor: (muiTheme: Theme) =>
    muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  pt: isMac ? `${macTitlebarHeight + 8}px` : 2,
  WebkitAppRegion: 'no-drag'
} as const
const runtimeSidebarActionButtonSize = 28
const runtimeSidebarHoverActionSx = {
  opacity: 0,
  pointerEvents: 'none',
  visibility: 'hidden',
  alignSelf: 'center',
  transition: 'opacity 120ms ease, visibility 120ms ease',
  '& .MuiIconButton-root': {
    width: runtimeSidebarActionButtonSize,
    height: runtimeSidebarActionButtonSize,
    bgcolor: 'transparent'
  }
} as const

function stateColor(state: JupyterServerState | AnalysisNotebookKernelState): string {
  if (state === 'ready' || state === 'idle') return '#35BFA5'
  if (
    [
      'busy',
      'starting',
      'restarting',
      'preparing_environment',
      'allocating_ports',
      'starting_lease',
      'probing_through_tunnel',
      'stopping',
      'cleaning',
      'reconciling'
    ].includes(state)
  ) {
    return '#E6B93F'
  }
  if (state === 'error' || state === 'missing' || state === 'exited') return '#F26D5B'
  return '#8A98A8'
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function normalizedKernelIconKind(value: string | null | undefined): 'python' | 'r' | null {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'python' || normalized.startsWith('python') || normalized === 'py') {
    return 'python'
  }
  if (normalized === 'r' || normalized === 'ir' || normalized.startsWith('r-')) return 'r'
  return null
}

function runtimeKernelIconKind(
  session: NonNullable<AnalysisJupyterRuntimeStatus['notebooks']>['sessions'][number]
): 'python' | 'r' | 'jupyter' {
  for (const candidate of [session.kernelName, session.kernelDisplayName]) {
    const iconKind = normalizedKernelIconKind(candidate)
    if (iconKind) return iconKind
  }
  return 'jupyter'
}

function RuntimeKernelIcon({
  kind
}: {
  kind: ReturnType<typeof runtimeKernelIconKind>
}): React.JSX.Element {
  useUiLanguage()
  if (kind === 'python') return <PythonIcon sx={{ fontSize: 22 }} />
  if (kind === 'r') return <RIcon sx={{ fontSize: 22 }} />
  return <NotebookIcon sx={{ fontSize: 22 }} />
}

function serverMetaLabel(status: AnalysisJupyterRuntimeStatus['server'] | null): string {
  if (status?.runtimeKind === 'ssh') {
    return status.message ? runtimeUi.loginNodeValue(status.message) : runtimeUi.loginNode
  }
  const parts = [
    status?.pid ? `PID ${status.pid}` : null,
    status?.port ? runtimeUi.port(status.port) : null
  ].filter(Boolean)

  if (parts.length > 0) return parts.join(' · ')
  if (status?.hasEndpoint) return runtimeUi.endpointReady
  return runtimeUi.noEndpoint
}

function RuntimeSidebarSection({
  projectCwd,
  runtimeStatus,
  showKernels = true,
  isLoading = false,
  onOpenNotebook,
  closingNotebookPath = null,
  onRefresh,
  onStartJupyter,
  onOpenStartLog,
  onStopJupyter,
  onStopNotebookKernel
}: RuntimeSidebarProps & { showKernels?: boolean }): React.JSX.Element {
  useUiLanguage()
  const server = runtimeStatus?.server ?? null
  const notebooks = runtimeStatus?.notebooks ?? null
  const notebookSessions = (notebooks?.sessions ?? []).filter(isListedNotebookKernel)
  const runningKernelCount = notebookSessions.length
  const actionBusy = isLoading
  const showStopServerAction = Boolean(
    server &&
    [
      'ready',
      'starting',
      'preparing_environment',
      'allocating_ports',
      'starting_lease',
      'probing_through_tunnel',
      'stopping',
      'cleaning',
      'reconciling'
    ].includes(server.state)
  )
  const showAbandonCleanupAction = Boolean(server?.state === 'error' && server.canAbandonCleanup)
  const canStart = Boolean(projectCwd) && !showStopServerAction
  const canStop = Boolean(projectCwd) && showStopServerAction

  return (
    <Box sx={{ flexShrink: 0 }}>
      <List disablePadding sx={{ py: 1 }}>
        <ListItemButton
          data-phi-runtime-sidebar-server="true"
          data-phi-runtime-sidebar-server-cwd={projectCwd}
          component="div"
          disableRipple
          sx={{
            alignItems: 'flex-start',
            mx: 0.75,
            mb: 1,
            pl: 0.25,
            pr: 1.25,
            py: 1.2,
            borderRadius: 1.5,
            cursor: 'default',
            backgroundColor: 'transparent !important',
            '&:hover': {
              backgroundColor: (theme) => `${alpha(theme.palette.primary.main, 0.06)} !important`
            },
            '&:hover .runtime-sidebar-row-actions, &:focus-within .runtime-sidebar-row-actions, &.Mui-focusVisible .runtime-sidebar-row-actions':
              {
                opacity: 1,
                pointerEvents: 'auto',
                visibility: 'visible'
              },
            '&:hover .runtime-sidebar-row-actions .MuiIconButton-root, &:focus-within .runtime-sidebar-row-actions .MuiIconButton-root, &.Mui-focusVisible .runtime-sidebar-row-actions .MuiIconButton-root':
              {
                bgcolor: 'transparent'
              },
            '& .runtime-sidebar-row-actions .MuiIconButton-root:hover': {
              bgcolor: 'action.hover'
            }
          }}
        >
          <Box
            sx={{
              width: 36,
              height: 36,
              mr: 1.25,
              borderRadius: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
              flexShrink: 0
            }}
          >
            <RunIcon fontSize="small" />
          </Box>
          <ListItemText
            primary={
              <Stack
                component="span"
                direction="row"
                spacing={0.75}
                sx={{ minWidth: 0, alignItems: 'center' }}
              >
                <Typography component="span" noWrap sx={{ minWidth: 0, fontWeight: 700 }}>
                  Jupyter Server
                </Typography>
                <Box
                  component="span"
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    bgcolor: stateColor(server?.state ?? 'stopped'),
                    flexShrink: 0
                  }}
                />
              </Stack>
            }
            secondary={
              <>
                <Box
                  component="span"
                  title={serverMetaLabel(server)}
                  sx={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden'
                  }}
                >
                  {fileName(projectCwd)} · {serverMetaLabel(server)}
                </Box>
                {server?.runtimeKind === 'ssh' && onOpenStartLog ? (
                  <Link
                    component="button"
                    type="button"
                    underline="hover"
                    data-phi-runtime-start-log
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpenStartLog()
                    }}
                    sx={{ fontSize: '0.78rem', mt: 0.25, display: 'inline-block' }}
                  >
                    {runtimeUi.viewStartupLog}
                  </Link>
                ) : null}
              </>
            }
            slotProps={{
              primary: { component: 'div' },
              secondary: { component: 'div', sx: { fontSize: '0.8rem' } }
            }}
          />
          <Stack
            className="runtime-sidebar-row-actions"
            direction="row"
            spacing={0.25}
            sx={{ ...runtimeSidebarHoverActionSx, ml: 0.75, flexShrink: 0 }}
          >
            <Tooltip title={runtimeUi.refreshServerStatus}>
              <span>
                <IconButton
                  size="small"
                  aria-label={runtimeUi.refreshServerStatus}
                  disabled={!projectCwd || actionBusy}
                  onClick={(event) => {
                    event.stopPropagation()
                    onRefresh()
                  }}
                >
                  <RefreshIcon size={19} />
                </IconButton>
              </span>
            </Tooltip>
            {showStopServerAction ? (
              <Tooltip title={runtimeUi.stopJupyterServer}>
                <span>
                  <IconButton
                    size="small"
                    aria-label={runtimeUi.stopJupyterServer}
                    disabled={!canStop || (actionBusy && server?.runtimeKind !== 'ssh')}
                    onClick={(event) => {
                      event.stopPropagation()
                      onStopJupyter(projectCwd)
                    }}
                    sx={{
                      color: canStop ? 'error.main' : 'text.disabled'
                    }}
                  >
                    <StopIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            ) : (
              <Tooltip title={runtimeUi.startJupyterServer}>
                <span>
                  <IconButton
                    size="small"
                    aria-label={runtimeUi.startJupyterServer}
                    disabled={!canStart || actionBusy}
                    onClick={(event) => {
                      event.stopPropagation()
                      onStartJupyter(projectCwd)
                    }}
                    sx={{
                      color: canStart ? 'primary.main' : 'text.disabled'
                    }}
                  >
                    <RunIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            )}
            {showAbandonCleanupAction ? (
              <Tooltip title={runtimeUi.discardLocalStateServerStateIsStillUnconfirmed}>
                <span>
                  <IconButton
                    size="small"
                    aria-label={runtimeUi.discardUnconfirmedLocalStateForRemoteJupyter}
                    disabled={!projectCwd || actionBusy}
                    onClick={(event) => {
                      event.stopPropagation()
                      onStopJupyter(projectCwd, { abandonUnconfirmed: true })
                    }}
                    sx={{ color: 'error.main' }}
                  >
                    <StopIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            ) : null}
          </Stack>
        </ListItemButton>

        {showKernels ? (
          <>
            <Box
              sx={{
                pl: 1,
                pr: 2,
                pt: 0.5,
                pb: 0.75,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 1
              }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 800 }}>
                {runtimeUi.notebookKernels}
              </Typography>
              <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
                <Chip
                  size="small"
                  variant="outlined"
                  label={`${runningKernelCount}`}
                  data-phi-runtime-sidebar-running-kernel-count="true"
                />
              </Stack>
            </Box>

            {notebookSessions.length > 0 ? (
              notebookSessions.map((session) => {
                const notebookName = fileName(session.notebookPath)
                const kernelIconKind = runtimeKernelIconKind(session)
                return (
                  <ListItemButton
                    key={`${session.projectCwd}:${session.notebookPath}`}
                    data-phi-runtime-sidebar-kernel="true"
                    onClick={() => onOpenNotebook?.(session.notebookPath)}
                    sx={{
                      alignItems: 'flex-start',
                      mx: 0.75,
                      pl: 0.25,
                      pr: 1.25,
                      py: 1,
                      borderRadius: 1.5,
                      backgroundColor: 'transparent !important',
                      '&:hover': {
                        backgroundColor: (theme) =>
                          `${alpha(theme.palette.primary.main, 0.06)} !important`
                      },
                      '&.Mui-disabled': {
                        opacity: 1
                      },
                      '&:hover .runtime-sidebar-row-actions, &:focus-within .runtime-sidebar-row-actions, &.Mui-focusVisible .runtime-sidebar-row-actions':
                        {
                          opacity: 1,
                          pointerEvents: 'auto',
                          visibility: 'visible'
                        },
                      '&:hover .runtime-sidebar-row-actions .MuiIconButton-root, &:focus-within .runtime-sidebar-row-actions .MuiIconButton-root, &.Mui-focusVisible .runtime-sidebar-row-actions .MuiIconButton-root':
                        {
                          bgcolor: 'transparent'
                        },
                      '& .runtime-sidebar-row-actions .MuiIconButton-root:hover': {
                        bgcolor: 'action.hover'
                      }
                    }}
                  >
                    <Box
                      sx={{
                        width: 34,
                        height: 34,
                        mr: 1.25,
                        borderRadius: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        bgcolor: (theme) =>
                          theme.palette.mode === 'dark'
                            ? alpha(theme.palette.common.white, 0.08)
                            : alpha(theme.palette.primary.main, 0.06),
                        flexShrink: 0
                      }}
                      data-phi-runtime-sidebar-kernel-icon={kernelIconKind}
                    >
                      <RuntimeKernelIcon kind={kernelIconKind} />
                    </Box>
                    <ListItemText
                      primary={notebookName}
                      secondary={kernelLabel(session)}
                      slotProps={{
                        primary: {
                          noWrap: true,
                          sx: { fontSize: '0.9rem', fontWeight: 650 }
                        },
                        secondary: {
                          sx: {
                            fontSize: '0.8rem',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden'
                          }
                        }
                      }}
                    />
                    <Stack
                      className="runtime-sidebar-row-actions"
                      direction="row"
                      spacing={0.25}
                      sx={{ ...runtimeSidebarHoverActionSx, ml: 0.75, flexShrink: 0 }}
                    >
                      <Tooltip title={runtimeUi.stopKernel}>
                        <span>
                          <IconButton
                            size="small"
                            aria-label={runtimeUi.stopValueKernel(notebookName)}
                            data-phi-runtime-sidebar-kernel-close="true"
                            data-phi-runtime-sidebar-kernel-close-state={
                              closingNotebookPath === session.notebookPath ? 'closing' : 'ready'
                            }
                            disabled={closingNotebookPath === session.notebookPath}
                            onClick={(event) => {
                              event.stopPropagation()
                              onStopNotebookKernel(session.notebookPath)
                            }}
                            sx={{
                              color:
                                closingNotebookPath === session.notebookPath
                                  ? 'text.disabled'
                                  : 'error.main'
                            }}
                          >
                            <StopIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  </ListItemButton>
                )
              })
            ) : (
              <Box
                data-phi-runtime-sidebar-empty-kernels="true"
                sx={{ px: 2, py: 2, color: 'text.secondary' }}
              >
                <Typography variant="body2">
                  {runtimeUi.noNotebookKernelsAreRunningInThisProject}
                </Typography>
              </Box>
            )}
          </>
        ) : null}
      </List>
    </Box>
  )
}

export function RuntimeSidebar(props: RuntimeSidebarProps): React.JSX.Element {
  useUiLanguage()
  const groups = groupRuntimeStatuses({
    projectCwd: props.projectCwd,
    runtimeStatus: props.runtimeStatus,
    currentRuntimeKind: props.currentRuntimeKind,
    currentServerLabel: props.currentServerLabel,
    additionalRuntimeStatuses: props.additionalRuntimeStatuses,
    localLabel: runtimeUi.local,
    remoteFallbackLabel: runtimeUi.sSHServer
  })
  return (
    <Box className="app-sidebar-surface" sx={{ ...runtimeSidebarSurfaceSx, overflowY: 'auto' }}>
      {groups.map((group) => (
        <Box
          key={group.key}
          role="group"
          aria-label={group.label}
          data-phi-runtime-group-kind={group.kind}
          data-phi-runtime-group-label={group.label}
          sx={{ flexShrink: 0 }}
        >
          <Typography
            variant="overline"
            color="text.secondary"
            sx={{ display: 'block', px: 2, pt: 1, fontWeight: 800, letterSpacing: '0.06em' }}
          >
            {group.label}
          </Typography>
          {group.entries.map((entry) => (
            <RuntimeSidebarSection
              key={entry.projectCwd}
              {...props}
              projectCwd={entry.projectCwd}
              runtimeStatus={entry.runtimeStatus}
              isLoading={entry.current ? props.isLoading : false}
              showKernels={entry.current}
              onOpenStartLog={entry.current ? props.onOpenStartLog : undefined}
            />
          ))}
        </Box>
      ))}
    </Box>
  )
}

function kernelLabel(
  session: NonNullable<AnalysisJupyterRuntimeStatus['notebooks']>['sessions'][number]
): string {
  return session.kernelDisplayName ?? session.kernelName ?? 'Kernel'
}
