import { useMemo, useState, type ReactNode } from 'react'
import {
  Box,
  Button,
  Chip,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography
} from '@mui/material'
import { PhiIcons } from '../../../icons'
import {
  jupyterServerStateColor,
  jupyterServerStateLabel,
  notebookArtifacts,
  notebookSessionStateColor,
  notebookSessionStateLabel,
  type NotebookListEntry
} from '../lib/notebookViewModel'
import type {
  AnalysisKernelDiagnostics,
  AnalysisNotebookFile,
  AnalysisNotebookRegistry,
  AnalysisNotebookSessionStatus,
  JupyterServerStatus
} from '../../../types'

export type InspectorTab = 'files' | 'variables' | 'artifacts'

const AddIcon = PhiIcons.action.add
const NotebookIcon = PhiIcons.file.jupyter
const PlayIcon = PhiIcons.action.run
const RefreshIcon = PhiIcons.action.refresh
const StopIcon = PhiIcons.action.stop
const DeleteIcon = PhiIcons.action.delete
const macTitlebarHeight = 44

function FilesTab({
  notebooks,
  activeNotebookPath,
  registry,
  isLoading,
  error,
  onOpenNotebook,
  onRefreshNotebooks,
  onCreateNotebook,
  onDeleteNotebook,
  onInitializeProjectAnalysis
}: {
  notebooks: NotebookListEntry[]
  activeNotebookPath: string | null
  registry?: AnalysisNotebookRegistry | null
  isLoading?: boolean
  error?: string | null
  onOpenNotebook?: (path: string) => void
  onRefreshNotebooks?: () => void
  onCreateNotebook?: (cwd: string) => void
  onDeleteNotebook?: (file: { path: string; relativePath: string }) => void
  onInitializeProjectAnalysis?: (cwd: string) => void
}): React.JSX.Element {
  const projectCwd = registry?.projectCwd ?? null
  const [pendingDeleteNotebook, setPendingDeleteNotebook] = useState<{
    path: string
    relativePath: string
  } | null>(null)
  const confirmDeleteNotebook = (): void => {
    if (!pendingDeleteNotebook) return
    onDeleteNotebook?.(pendingDeleteNotebook)
    setPendingDeleteNotebook(null)
  }

  return (
    <>
      <List dense disablePadding>
        <Box sx={{ px: 1, pb: 1, display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0 }} noWrap>
            {registry?.projectName ?? 'Project notebooks'}
          </Typography>
          {onRefreshNotebooks ? (
            <Tooltip title="刷新 notebooks">
              <IconButton size="small" aria-label="刷新 notebooks" onClick={onRefreshNotebooks}>
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
          {projectCwd && onCreateNotebook ? (
            <Tooltip title="新建 notebook">
              <IconButton
                size="small"
                aria-label="新建 notebook"
                onClick={() => onCreateNotebook(projectCwd)}
              >
                <AddIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
        </Box>
        {isLoading ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 1.5 }}>
            正在扫描 notebooks...
          </Typography>
        ) : null}
        {error ? (
          <Typography variant="body2" color="error.main" sx={{ px: 1, py: 1.5 }}>
            {error}
          </Typography>
        ) : null}
        {!isLoading && !error && !registry ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 1.5 }}>
            连接项目后显示真实 notebook 文件。
          </Typography>
        ) : null}
        {!isLoading && !error && registry?.message ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 1.5 }}>
            {registry.message}
          </Typography>
        ) : null}
        {!isLoading && !error && projectCwd && notebooks.length === 0 ? (
          <Box sx={{ px: 1, py: 1.5 }}>
            <Typography variant="body2" color="text.secondary">
              当前项目还没有 notebook。
            </Typography>
            {!registry?.initialized && onInitializeProjectAnalysis ? (
              <Button
                size="small"
                variant="outlined"
                startIcon={<AddIcon fontSize="small" />}
                sx={{ mt: 1 }}
                onClick={() => onInitializeProjectAnalysis(projectCwd)}
              >
                初始化分析目录
              </Button>
            ) : null}
          </Box>
        ) : null}
        {registry?.truncated ? (
          <Typography
            variant="caption"
            color="warning.main"
            sx={{ display: 'block', px: 1, pb: 1 }}
          >
            扫描结果已截断，请缩小项目目录或移动 notebook 到 notebooks/。
          </Typography>
        ) : null}
        {!isLoading && !error && registry
          ? notebooks.map((notebook) => {
              const canOpen = Boolean(notebook.absolutePath && onOpenNotebook)
              const canDelete = Boolean(notebook.absolutePath && onDeleteNotebook)
              return (
                <Box
                  key={notebook.id}
                  sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.25, mb: 0.35 }}
                >
                  <ListItemButton
                    selected={notebook.path === activeNotebookPath}
                    disabled={!canOpen}
                    aria-label={`打开 ${notebook.path}`}
                    onClick={() => {
                      if (notebook.absolutePath) onOpenNotebook?.(notebook.absolutePath)
                    }}
                    sx={{ minWidth: 0, px: 1, borderRadius: 1, alignItems: 'flex-start' }}
                  >
                    <NotebookIcon
                      fontSize="small"
                      sx={{
                        mt: 0.25,
                        mr: 1,
                        color:
                          notebook.path === activeNotebookPath ? 'primary.main' : 'text.secondary'
                      }}
                    />
                    <ListItemText
                      primary={notebook.path}
                      secondary={notebook.status}
                      slotProps={{
                        primary: {
                          noWrap: true,
                          sx: {
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.8rem',
                            fontWeight: 700
                          }
                        },
                        secondary: { sx: { fontSize: '0.72rem' } }
                      }}
                    />
                  </ListItemButton>
                  {canDelete ? (
                    <Tooltip title="删除 notebook">
                      <IconButton
                        size="small"
                        color="error"
                        aria-label={`删除 ${notebook.path}`}
                        onClick={() => {
                          if (!notebook.absolutePath) return
                          setPendingDeleteNotebook({
                            path: notebook.absolutePath,
                            relativePath: notebook.path
                          })
                        }}
                        sx={{ mt: 0.1, ml: 0.5, width: 28, height: 28 }}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                </Box>
              )
            })
          : null}
      </List>
      <Dialog
        open={Boolean(pendingDeleteNotebook)}
        onClose={() => setPendingDeleteNotebook(null)}
        maxWidth="xs"
        fullWidth
        data-phi-notebook-delete-dialog="true"
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontWeight: 800 }}>
          <DeleteIcon fontSize="small" />
          删除 notebook
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.65 }}>
            将删除这个 notebook 文件。这个操作会修改项目文件，确认后立即执行。
          </Typography>
          <Typography
            variant="body2"
            sx={{
              mt: 1.25,
              px: 1.25,
              py: 1,
              borderRadius: 1.5,
              bgcolor: 'action.hover',
              fontFamily: 'var(--font-mono)',
              overflowWrap: 'anywhere'
            }}
          >
            {pendingDeleteNotebook?.relativePath}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
          <Button onClick={() => setPendingDeleteNotebook(null)} sx={{ borderRadius: 999 }}>
            取消
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={confirmDeleteNotebook}
            sx={{ borderRadius: 999, px: 2 }}
          >
            删除
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

function KernelStatusSummary({
  projectCwd,
  diagnostics,
  isLoading,
  error,
  serverStatus,
  isStartingServer,
  serverError,
  notebookSessionStatus,
  onRefresh,
  onRefreshServer,
  onStartServer,
  onStopServer
}: {
  projectCwd?: string | null
  diagnostics?: AnalysisKernelDiagnostics | null
  isLoading?: boolean
  error?: string | null
  serverStatus?: JupyterServerStatus | null
  isStartingServer?: boolean
  serverError?: string | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  onRefresh?: () => void
  onRefreshServer?: () => void
  onStartServer?: (cwd: string) => void
  onStopServer?: (cwd: string) => void
}): React.JSX.Element {
  const serverLabel = isLoading
    ? 'Checking'
    : diagnostics?.jupyterServer.available
      ? `Jupyter ${diagnostics.jupyterServer.version ?? 'available'}`
      : 'Jupyter missing'
  const canStopServer = serverStatus?.state === 'starting' || serverStatus?.state === 'ready'
  const canControlServer = Boolean(projectCwd && (onStartServer || onStopServer))
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.25, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" sx={{ flex: 1, fontWeight: 800 }}>
          Kernel
        </Typography>
        {onRefresh ? (
          <Tooltip title="刷新 kernels">
            <IconButton size="small" onClick={onRefresh}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>
      <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.75 }}>
        <Chip size="small" variant="outlined" label={serverLabel} />
        <Chip
          size="small"
          color={jupyterServerStateColor(serverStatus)}
          variant="outlined"
          label={jupyterServerStateLabel(serverStatus)}
        />
        <Chip
          size="small"
          color={notebookSessionStateColor(notebookSessionStatus)}
          variant="outlined"
          label={notebookSessionStateLabel(notebookSessionStatus)}
        />
        <Chip
          size="small"
          color={diagnostics?.hasPythonKernel ? 'success' : 'warning'}
          variant="outlined"
          label={diagnostics?.hasPythonKernel ? 'Python kernel' : 'Python missing'}
        />
        <Chip
          size="small"
          color={diagnostics?.hasRKernel ? 'success' : 'warning'}
          variant="outlined"
          label={diagnostics?.hasRKernel ? 'R kernel' : 'R missing'}
        />
      </Stack>
      {canControlServer ? (
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <Button
            size="small"
            variant={canStopServer ? 'outlined' : 'contained'}
            startIcon={
              canStopServer ? <StopIcon fontSize="small" /> : <PlayIcon fontSize="small" />
            }
            disabled={Boolean(isStartingServer)}
            onClick={() => {
              if (!projectCwd) return
              if (canStopServer) {
                onStopServer?.(projectCwd)
              } else {
                onStartServer?.(projectCwd)
              }
            }}
          >
            {canStopServer ? '停止 Jupyter' : '启动 Jupyter'}
          </Button>
          {onRefreshServer ? (
            <Button
              size="small"
              variant="text"
              startIcon={<RefreshIcon fontSize="small" />}
              onClick={onRefreshServer}
            >
              状态
            </Button>
          ) : null}
        </Stack>
      ) : null}
      {error ? (
        <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 1 }}>
          {error}
        </Typography>
      ) : null}
      {serverError ? (
        <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 1 }}>
          {serverError}
        </Typography>
      ) : null}
      {serverStatus?.message ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
          {serverStatus.message}
        </Typography>
      ) : null}
      {notebookSessionStatus?.message ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
          {notebookSessionStatus.message}
        </Typography>
      ) : null}
      {diagnostics?.messages.map((message) => (
        <Typography
          key={message}
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 0.75 }}
        >
          {message}
        </Typography>
      ))}
    </Box>
  )
}

function VariablesTab({
  projectCwd,
  kernelDiagnostics,
  isLoadingKernels,
  kernelError,
  jupyterServerStatus,
  isStartingJupyterServer,
  jupyterServerError,
  notebookSessionStatus,
  onRefreshKernels,
  onRefreshJupyterServer,
  onStartJupyterServer,
  onStopJupyterServer
}: {
  projectCwd?: string | null
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  isLoadingKernels?: boolean
  kernelError?: string | null
  jupyterServerStatus?: JupyterServerStatus | null
  isStartingJupyterServer?: boolean
  jupyterServerError?: string | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  onRefreshKernels?: () => void
  onRefreshJupyterServer?: () => void
  onStartJupyterServer?: (cwd: string) => void
  onStopJupyterServer?: (cwd: string) => void
}): React.JSX.Element {
  return (
    <Stack spacing={1}>
      <KernelStatusSummary
        projectCwd={projectCwd}
        diagnostics={kernelDiagnostics}
        isLoading={isLoadingKernels}
        error={kernelError}
        serverStatus={jupyterServerStatus}
        isStartingServer={isStartingJupyterServer}
        serverError={jupyterServerError}
        notebookSessionStatus={notebookSessionStatus}
        onRefresh={onRefreshKernels}
        onRefreshServer={onRefreshJupyterServer}
        onStartServer={onStartJupyterServer}
        onStopServer={onStopJupyterServer}
      />
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.25 }}>
        <Typography variant="body2" sx={{ fontWeight: 700 }}>
          变量检查
        </Typography>
        <Typography variant="caption" color="text.secondary">
          暂时保持收起；接入真实 kernel 变量抓取 API 后再显示变量列表。
        </Typography>
      </Box>
    </Stack>
  )
}

function ArtifactsTab({
  notebookFile
}: {
  notebookFile?: AnalysisNotebookFile | null
}): React.JSX.Element {
  const artifacts = notebookArtifacts(notebookFile?.document)

  return (
    <Stack spacing={1}>
      {notebookFile ? (
        <>
          <Typography variant="caption" color="text.secondary" noWrap>
            {notebookFile.relativePath}
          </Typography>
          {artifacts.length > 0 ? (
            artifacts.map((artifact) => (
              <Box
                key={artifact.id}
                sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.25, minWidth: 0 }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0, fontWeight: 800 }}>
                    {artifact.name}
                  </Typography>
                  <Chip size="small" label={artifact.kind} />
                </Box>
                <Typography variant="caption" color="text.secondary">
                  {artifact.source} · {artifact.size}
                </Typography>
              </Box>
            ))
          ) : (
            <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.25 }}>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                没有输出产物
              </Typography>
              <Typography variant="caption" color="text.secondary">
                运行产生 HTML、图片或 JSON 输出的 cell 后，这里会显示真实产物。
              </Typography>
            </Box>
          )}
        </>
      ) : (
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.25 }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            还没有打开 notebook
          </Typography>
          <Typography variant="caption" color="text.secondary">
            打开 notebook 后显示真实输出产物。
          </Typography>
        </Box>
      )}
    </Stack>
  )
}

function InspectorContent({
  tab,
  notebooks,
  activeNotebookPath,
  notebookRegistry,
  notebookFile,
  isLoadingNotebooks,
  notebookError,
  projectCwd,
  kernelDiagnostics,
  isLoadingKernels,
  kernelError,
  jupyterServerStatus,
  isStartingJupyterServer,
  jupyterServerError,
  notebookSessionStatus,
  onOpenNotebook,
  onRefreshNotebooks,
  onCreateNotebook,
  onDeleteNotebook,
  onInitializeProjectAnalysis,
  onRefreshKernels,
  onRefreshJupyterServer,
  onStartJupyterServer,
  onStopJupyterServer
}: {
  tab: InspectorTab
  notebooks: NotebookListEntry[]
  activeNotebookPath: string | null
  notebookRegistry?: AnalysisNotebookRegistry | null
  notebookFile?: AnalysisNotebookFile | null
  isLoadingNotebooks?: boolean
  notebookError?: string | null
  projectCwd?: string | null
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  isLoadingKernels?: boolean
  kernelError?: string | null
  jupyterServerStatus?: JupyterServerStatus | null
  isStartingJupyterServer?: boolean
  jupyterServerError?: string | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  onOpenNotebook?: (path: string) => void
  onRefreshNotebooks?: () => void
  onCreateNotebook?: (cwd: string) => void
  onDeleteNotebook?: (file: { path: string; relativePath: string }) => void
  onInitializeProjectAnalysis?: (cwd: string) => void
  onRefreshKernels?: () => void
  onRefreshJupyterServer?: () => void
  onStartJupyterServer?: (cwd: string) => void
  onStopJupyterServer?: (cwd: string) => void
}): React.JSX.Element {
  if (tab === 'variables') {
    return (
      <VariablesTab
        projectCwd={projectCwd}
        kernelDiagnostics={kernelDiagnostics}
        isLoadingKernels={isLoadingKernels}
        kernelError={kernelError}
        jupyterServerStatus={jupyterServerStatus}
        isStartingJupyterServer={isStartingJupyterServer}
        jupyterServerError={jupyterServerError}
        notebookSessionStatus={notebookSessionStatus}
        onRefreshKernels={onRefreshKernels}
        onRefreshJupyterServer={onRefreshJupyterServer}
        onStartJupyterServer={onStartJupyterServer}
        onStopJupyterServer={onStopJupyterServer}
      />
    )
  }
  if (tab === 'artifacts') return <ArtifactsTab notebookFile={notebookFile} />
  return (
    <FilesTab
      notebooks={notebooks}
      activeNotebookPath={activeNotebookPath}
      registry={notebookRegistry}
      isLoading={isLoadingNotebooks}
      error={notebookError}
      onOpenNotebook={onOpenNotebook}
      onRefreshNotebooks={onRefreshNotebooks}
      onCreateNotebook={onCreateNotebook}
      onDeleteNotebook={onDeleteNotebook}
      onInitializeProjectAnalysis={onInitializeProjectAnalysis}
    />
  )
}

export function RightInspector({
  tab,
  width,
  fullscreen = false,
  notebooks,
  activeNotebookPath,
  notebookRegistry,
  notebookFile,
  isLoadingNotebooks,
  notebookError,
  projectCwd,
  kernelDiagnostics,
  isLoadingKernels,
  kernelError,
  jupyterServerStatus,
  isStartingJupyterServer,
  jupyterServerError,
  notebookSessionStatus,
  onTabChange,
  onOpenNotebook,
  onRefreshNotebooks,
  onCreateNotebook,
  onDeleteNotebook,
  onInitializeProjectAnalysis,
  onRefreshKernels,
  onRefreshJupyterServer,
  onStartJupyterServer,
  onStopJupyterServer,
  topRightControls
}: {
  tab: InspectorTab
  width: number | string
  fullscreen?: boolean
  notebooks: NotebookListEntry[]
  activeNotebookPath: string | null
  notebookRegistry?: AnalysisNotebookRegistry | null
  notebookFile?: AnalysisNotebookFile | null
  isLoadingNotebooks?: boolean
  notebookError?: string | null
  projectCwd?: string | null
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  isLoadingKernels?: boolean
  kernelError?: string | null
  jupyterServerStatus?: JupyterServerStatus | null
  isStartingJupyterServer?: boolean
  jupyterServerError?: string | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  onTabChange: (tab: InspectorTab) => void
  onOpenNotebook?: (path: string) => void
  onRefreshNotebooks?: () => void
  onCreateNotebook?: (cwd: string) => void
  onDeleteNotebook?: (file: { path: string; relativePath: string }) => void
  onInitializeProjectAnalysis?: (cwd: string) => void
  onRefreshKernels?: () => void
  onRefreshJupyterServer?: () => void
  onStartJupyterServer?: (cwd: string) => void
  onStopJupyterServer?: (cwd: string) => void
  topRightControls?: ReactNode
}): React.JSX.Element {
  const tabs = useMemo(
    () => [
      { value: 'files' as const, label: 'Files' },
      { value: 'variables' as const, label: 'Variables' },
      { value: 'artifacts' as const, label: 'Artifacts' }
    ],
    []
  )

  return (
    <Box
      sx={{
        width,
        flexShrink: 0,
        borderLeft: fullscreen ? 0 : 1,
        borderColor: 'divider',
        display: 'flex',
        minHeight: 0,
        flexDirection: 'column',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF'
      }}
    >
      {topRightControls ? (
        <Box
          sx={{
            height: macTitlebarHeight,
            flexShrink: 0,
            borderBottom: 1,
            borderColor: 'divider',
            px: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            WebkitAppRegion: 'drag'
          }}
        >
          {topRightControls}
        </Box>
      ) : null}
      <Box
        sx={{
          minHeight: 36,
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          pl: 1,
          pr: 1
        }}
      >
        <Tabs
          value={tab}
          onChange={(_, value: InspectorTab) => onTabChange(value)}
          variant="fullWidth"
          sx={{
            flex: 1,
            minHeight: 36,
            minWidth: 0,
            '& .MuiTab-root': { minHeight: 36, py: 0.5, px: 0.5 }
          }}
        >
          {tabs.map(({ value, label }) => (
            <Tab key={value} value={value} label={label} />
          ))}
        </Tabs>
      </Box>
      <Divider />
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 1.5 }}>
        <InspectorContent
          tab={tab}
          notebooks={notebooks}
          activeNotebookPath={activeNotebookPath}
          notebookRegistry={notebookRegistry}
          notebookFile={notebookFile}
          isLoadingNotebooks={isLoadingNotebooks}
          notebookError={notebookError}
          projectCwd={projectCwd}
          kernelDiagnostics={kernelDiagnostics}
          isLoadingKernels={isLoadingKernels}
          kernelError={kernelError}
          jupyterServerStatus={jupyterServerStatus}
          isStartingJupyterServer={isStartingJupyterServer}
          jupyterServerError={jupyterServerError}
          notebookSessionStatus={notebookSessionStatus}
          onOpenNotebook={onOpenNotebook}
          onRefreshNotebooks={onRefreshNotebooks}
          onCreateNotebook={onCreateNotebook}
          onDeleteNotebook={onDeleteNotebook}
          onInitializeProjectAnalysis={onInitializeProjectAnalysis}
          onRefreshKernels={onRefreshKernels}
          onRefreshJupyterServer={onRefreshJupyterServer}
          onStartJupyterServer={onStartJupyterServer}
          onStopJupyterServer={onStopJupyterServer}
        />
      </Box>
    </Box>
  )
}
