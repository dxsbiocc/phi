import { Box, Chip, Divider, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { PhiIcons } from '../../icons'
import type {
  AnalysisJupyterRuntimeStatus,
  AnalysisNotebookKernelState,
  JupyterServerState
} from '../../types'

export interface RuntimeViewProps {
  projectCwd: string
  projectName?: string
  runtimeStatus: AnalysisJupyterRuntimeStatus | null
  isLoading?: boolean
  closingNotebookPath?: string | null
  error?: string | null
  onRefresh: () => void
  onStartJupyter: (cwd: string) => void
  onStopJupyter: (cwd: string) => void
  onOpenNotebook?: (notebookPath: string) => void
  onStopNotebookKernel: (notebookPath: string) => void
}

const RefreshIcon = PhiIcons.action.refresh
const RunIcon = PhiIcons.action.run
const StopIcon = PhiIcons.action.stop
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const macTitlebarHeight = 44

function serverStateLabel(state: JupyterServerState): string {
  switch (state) {
    case 'ready':
      return 'Ready'
    case 'starting':
      return 'Starting'
    case 'error':
      return 'Error'
    case 'exited':
      return 'Exited'
    case 'stopped':
      return 'Stopped'
  }
}

function kernelStateLabel(state: AnalysisNotebookKernelState): string {
  switch (state) {
    case 'idle':
      return 'Idle'
    case 'busy':
      return 'Running'
    case 'restarting':
      return 'Restarting'
    case 'disconnected':
      return 'Disconnected'
    case 'missing':
      return 'Missing'
    case 'error':
      return 'Error'
  }
}

function stateColor(state: JupyterServerState | AnalysisNotebookKernelState): string {
  if (state === 'ready' || state === 'idle') return '#35BFA5'
  if (state === 'busy' || state === 'starting' || state === 'restarting') return '#E6B93F'
  if (state === 'error' || state === 'missing' || state === 'exited') return '#F26D5B'
  return '#8A98A8'
}

function formatTimestamp(value?: string): string {
  if (!value) return 'unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    month: '2-digit',
    day: '2-digit'
  })
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function serverDescription(status: AnalysisJupyterRuntimeStatus['server'] | null): string {
  if (!status) return '刷新状态后显示当前项目的 Jupyter Server。'
  if (status.state === 'ready') return 'Server 正在为当前项目运行，notebook 可按需连接 kernel。'
  if (status.state === 'starting') return 'Server 正在启动。'
  if (status.state === 'stopped') return 'Server 已停止，启动后可连接 notebook kernel。'
  if (status.state === 'exited') return 'Server 已退出，可以重新启动。'
  return 'Server 需要处理，请查看运行状态或重新启动。'
}

function serverMetaLabel(status: AnalysisJupyterRuntimeStatus['server'] | null): string {
  const parts = [
    status?.pid ? `PID ${status.pid}` : null,
    status?.port ? `Port ${status.port}` : null
  ].filter(Boolean)

  if (parts.length > 0) return parts.join(' · ')
  if (status?.hasEndpoint) return 'Endpoint ready'
  return 'No endpoint'
}

function kernelDescription(
  session: NonNullable<AnalysisJupyterRuntimeStatus['notebooks']>['sessions'][number]
): string {
  const kernel = session.kernelDisplayName ?? session.kernelName ?? 'Kernel'
  if (session.state === 'busy') return `${kernel} · 正在执行`
  if (session.state === 'idle') return `${kernel} · 已连接`
  if (session.state === 'restarting') return `${kernel} · 正在重启`
  if (session.state === 'disconnected') return `${kernel} · 已断开`
  if (session.state === 'missing') return `${kernel} · 不可用`
  return `${kernel} · 需要处理`
}

export default function RuntimeView({
  projectCwd,
  projectName,
  runtimeStatus,
  isLoading = false,
  closingNotebookPath = null,
  error = null,
  onRefresh,
  onStartJupyter,
  onStopJupyter,
  onOpenNotebook,
  onStopNotebookKernel
}: RuntimeViewProps): React.JSX.Element {
  const server = runtimeStatus?.server ?? null
  const notebooks = runtimeStatus?.notebooks ?? null
  const actionBusy = isLoading
  const canStart = Boolean(projectCwd) && server?.state !== 'ready' && server?.state !== 'starting'
  const canStop = Boolean(projectCwd) && server !== null && server.state !== 'stopped'
  const activeCount = notebooks?.activeSessionCount ?? 0
  const busyCount = notebooks?.busySessionCount ?? 0
  const statusMessage = projectCwd
    ? serverDescription(server)
    : '先从左侧项目列表打开一个项目会话，再管理它的本地 Jupyter runtime。'

  return (
    <Box
      component="main"
      sx={{
        flex: 1,
        minWidth: 0,
        height: '100vh',
        bgcolor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        pt: isMac ? `${macTitlebarHeight}px` : 0
      }}
    >
      <Box
        sx={{
          minHeight: 56,
          borderBottom: 1,
          borderColor: 'divider',
          px: { xs: 2, md: 3 },
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
            Jupyter Runtime
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
            {projectName ? `${projectName} · ` : ''}
            {projectCwd || '未选择项目'}
          </Typography>
        </Box>
      </Box>

      <Box sx={{ overflow: 'auto', px: { xs: 2, md: 3 }, py: 3 }}>
        <Stack spacing={2.5} sx={{ width: '100%', maxWidth: 980, mx: 'auto' }}>
          {error && projectCwd ? (
            <Box
              role="alert"
              sx={{
                border: 1,
                borderColor: 'error.light',
                borderRadius: 2,
                bgcolor: (theme) =>
                  theme.palette.mode === 'dark' ? 'rgba(242, 109, 91, 0.14)' : '#FFF4F2',
                color: 'error.dark',
                px: 2,
                py: 1.25,
                overflowWrap: 'anywhere'
              }}
            >
              <Typography variant="body2">{error}</Typography>
            </Box>
          ) : null}

          <Box
            sx={{
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              bgcolor: 'background.paper',
              overflow: 'hidden'
            }}
          >
            <Box
              sx={{
                px: 2,
                py: 1.5,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 2
              }}
            >
              <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
                <Box
                  sx={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    bgcolor: stateColor(server?.state ?? 'stopped')
                  }}
                />
                <Typography sx={{ fontWeight: 700 }}>Jupyter Server</Typography>
                <Chip
                  size="small"
                  label={server ? serverStateLabel(server.state) : 'Unchecked'}
                  variant="outlined"
                />
              </Stack>
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                <Typography variant="body2" color="text.secondary" sx={{ mr: 0.5 }}>
                  {serverMetaLabel(server)}
                </Typography>
                <Tooltip title="刷新 Server 状态">
                  <span>
                    <IconButton
                      size="small"
                      aria-label="刷新 Server 状态"
                      disabled={!projectCwd || actionBusy}
                      onClick={onRefresh}
                      sx={{
                        width: 36,
                        height: 36,
                        border: 1,
                        borderColor: 'divider'
                      }}
                    >
                      <RefreshIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title="启动 Jupyter server">
                  <span>
                    <IconButton
                      size="small"
                      aria-label="启动 Jupyter server"
                      disabled={!canStart || actionBusy}
                      onClick={() => onStartJupyter(projectCwd)}
                      sx={{
                        width: 36,
                        height: 36,
                        border: 1,
                        borderColor: canStart ? 'primary.main' : 'divider',
                        color: canStart ? 'primary.main' : 'text.disabled'
                      }}
                    >
                      <RunIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title="停止 Jupyter server">
                  <span>
                    <IconButton
                      size="small"
                      aria-label="停止 Jupyter server"
                      disabled={!canStop || actionBusy}
                      onClick={() => onStopJupyter(projectCwd)}
                      sx={{
                        width: 36,
                        height: 36,
                        border: 1,
                        borderColor: canStop ? 'error.light' : 'divider',
                        color: canStop ? 'error.main' : 'text.disabled',
                        '&:hover': canStop
                          ? {
                              borderColor: 'error.main',
                              bgcolor: (theme) => alpha(theme.palette.error.main, 0.08)
                            }
                          : undefined
                      }}
                    >
                      <StopIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
            </Box>
            <Divider />
            <Box sx={{ px: 2, py: 1.5 }}>
              <Typography variant="body2" color="text.secondary">
                {statusMessage}
              </Typography>
              {server?.startedAt ? (
                <Typography variant="caption" color="text.secondary">
                  Started {formatTimestamp(server.startedAt)}
                </Typography>
              ) : null}
            </Box>
          </Box>

          <Box>
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}
            >
              <Typography sx={{ fontWeight: 700 }}>Notebook Kernels</Typography>
              <Stack direction="row" spacing={1}>
                <Chip size="small" label={`${activeCount} active`} variant="outlined" />
                <Chip size="small" label={`${busyCount} running`} variant="outlined" />
              </Stack>
            </Stack>

            {notebooks && notebooks.sessions.length > 0 ? (
              <Stack spacing={1}>
                {notebooks.sessions.map((session) => (
                  <Box
                    key={`${session.projectCwd}:${session.notebookPath}`}
                    sx={{
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: 2,
                      bgcolor: 'background.paper',
                      px: 2,
                      py: 1.25,
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) auto auto',
                      gap: 1.5,
                      alignItems: 'center'
                    }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.25 }}>
                        <Box
                          sx={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            bgcolor: stateColor(session.state)
                          }}
                        />
                        {onOpenNotebook ? (
                          <Box
                            component="button"
                            type="button"
                            data-phi-runtime-notebook-open="true"
                            data-phi-runtime-notebook-open-target="filename"
                            aria-label={`打开 ${fileName(session.notebookPath)}`}
                            onClick={() => onOpenNotebook(session.notebookPath)}
                            sx={{
                              minWidth: 0,
                              p: 0,
                              border: 0,
                              bgcolor: 'transparent',
                              color: 'inherit',
                              cursor: 'pointer',
                              font: 'inherit',
                              textAlign: 'left',
                              '&:hover .runtime-notebook-name': {
                                textDecoration: 'underline',
                                textUnderlineOffset: '3px'
                              },
                              '&:focus-visible': {
                                outline: (theme) => `2px solid ${theme.palette.primary.main}`,
                                outlineOffset: 2,
                                borderRadius: 0.75
                              }
                            }}
                          >
                            <Typography
                              className="runtime-notebook-name"
                              sx={{ fontWeight: 650 }}
                              noWrap
                            >
                              {fileName(session.notebookPath)}
                            </Typography>
                          </Box>
                        ) : (
                          <Typography sx={{ fontWeight: 650 }} noWrap>
                            {fileName(session.notebookPath)}
                          </Typography>
                        )}
                        <Chip
                          size="small"
                          label={kernelStateLabel(session.state)}
                          variant="outlined"
                        />
                      </Stack>
                      <Typography variant="body2" color="text.secondary" noWrap>
                        {kernelDescription(session)}
                      </Typography>
                    </Box>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ whiteSpace: 'nowrap' }}
                    >
                      Updated {formatTimestamp(session.updatedAt ?? session.startedAt)}
                    </Typography>
                    <Tooltip title="关闭 kernel">
                      <span>
                        <IconButton
                          size="small"
                          aria-label={`关闭 ${fileName(session.notebookPath)} kernel`}
                          data-phi-runtime-notebook-close-kernel="true"
                          data-phi-runtime-notebook-close-state={
                            closingNotebookPath === session.notebookPath ? 'closing' : 'ready'
                          }
                          disabled={closingNotebookPath === session.notebookPath}
                          onClick={() => onStopNotebookKernel(session.notebookPath)}
                          sx={{
                            width: 36,
                            height: 36,
                            border: 1,
                            borderColor:
                              closingNotebookPath === session.notebookPath
                                ? 'divider'
                                : 'error.light',
                            color:
                              closingNotebookPath === session.notebookPath
                                ? 'text.disabled'
                                : 'error.main',
                            '&:hover':
                              closingNotebookPath === session.notebookPath
                                ? undefined
                                : {
                                    borderColor: 'error.main',
                                    bgcolor: (theme) => alpha(theme.palette.error.main, 0.08)
                                  }
                          }}
                        >
                          <StopIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Box>
                ))}
              </Stack>
            ) : (
              <Box
                sx={{
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 2,
                  bgcolor: 'background.paper',
                  px: 2,
                  py: 3,
                  textAlign: 'center'
                }}
              >
                <Typography color="text.secondary">
                  当前项目还没有连接中的 notebook kernel。
                </Typography>
              </Box>
            )}
          </Box>
        </Stack>
      </Box>
    </Box>
  )
}
