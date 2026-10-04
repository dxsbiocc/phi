import type { ReactNode } from 'react'
import { Box, IconButton, Tooltip, Typography } from '@mui/material'
import { GoScreenFull, GoScreenNormal, GoX } from 'react-icons/go'
import { PhiIcons } from '../icons'
import type { WorkspaceSidePanelMode } from '../lib/workspaceSidePanelMode'
import type { DirectoryListing } from '../types'
import { ProjectFileTree } from '../features/file-preview/components/ProjectFileTree'

const DirectoryTreeIcon = PhiIcons.entity.directoryTree
const TerminalIcon = PhiIcons.tool.command

const workspacePanelLabels: Record<WorkspaceSidePanelMode, string> = {
  jobs: '后台任务',
  terminal: '终端',
  browser: '浏览器'
}

export interface WorkspaceSidePanelSlotRenderContext {
  headerActions: ReactNode
}

function WorkspaceToolCard({
  kind,
  label,
  Icon
}: {
  kind: 'terminal'
  label: string
  Icon: typeof TerminalIcon
}): React.JSX.Element {
  return (
    <Box
      data-phi-workspace-side-panel-tool-card={kind}
      sx={{
        flex: 1,
        minHeight: 0,
        color: 'text.primary',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.25,
        px: 1.5,
        textAlign: 'center'
      }}
    >
      <Icon sx={{ fontSize: 24, color: 'primary.main', flexShrink: 0 }} />
      <Typography variant="body1" sx={{ minWidth: 0, fontWeight: 800 }} noWrap>
        {label}
      </Typography>
    </Box>
  )
}

function WorkspaceSidePanelSlotActions({
  mode,
  maximized,
  showLayoutAction,
  onToggleMaximized,
  onClose
}: {
  mode: WorkspaceSidePanelMode
  maximized: boolean
  showLayoutAction: boolean
  onToggleMaximized: () => void
  onClose: () => void
}): React.JSX.Element {
  const label = workspacePanelLabels[mode]
  const actionSx = {
    width: 44,
    height: 44,
    borderRadius: 1.25,
    color: 'text.secondary',
    WebkitAppRegion: 'no-drag',
    '&:hover, &:focus-visible': { bgcolor: 'action.hover', color: 'text.primary' }
  } as const

  return (
    <Box
      data-phi-workspace-side-panel-slot-actions={mode}
      sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}
    >
      {showLayoutAction ? (
        <Tooltip title={maximized ? '还原分屏' : `在右侧工作区展开${label}`}>
          <IconButton
            type="button"
            aria-label={maximized ? '还原分屏' : `在右侧工作区展开${label}`}
            aria-pressed={maximized}
            onClick={onToggleMaximized}
            sx={actionSx}
          >
            {maximized ? <GoScreenNormal size={18} /> : <GoScreenFull size={18} />}
          </IconButton>
        </Tooltip>
      ) : null}
      <Tooltip title={`关闭${label}`}>
        <IconButton type="button" aria-label={`关闭${label}`} onClick={onClose} sx={actionSx}>
          <GoX size={20} />
        </IconButton>
      </Tooltip>
    </Box>
  )
}

function WorkspaceSidePanelSlotHeader({
  mode,
  actions
}: {
  mode: Exclude<WorkspaceSidePanelMode, 'browser'>
  actions: ReactNode
}): React.JSX.Element {
  return (
    <Box
      data-phi-workspace-side-panel-slot-header={mode}
      sx={{
        height: 50,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        pl: 1.5,
        pr: 0.5,
        borderBottom: 1,
        borderColor: 'divider',
        WebkitAppRegion: 'drag'
      }}
    >
      <Typography variant="body2" sx={{ flex: 1, minWidth: 0, fontWeight: 700 }} noWrap>
        {workspacePanelLabels[mode]}
      </Typography>
      {actions}
    </Box>
  )
}

export function WorkspaceFilesPane({
  rootPath,
  activePath,
  treeRevision,
  onOpenFile,
  onListDirectory
}: {
  rootPath?: string | null
  activePath?: string | null
  treeRevision: number
  onOpenFile?: (path: string) => void
  onListDirectory?: (path: string) => Promise<DirectoryListing>
}): React.JSX.Element {
  if (!rootPath || !onOpenFile || !onListDirectory) {
    return (
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          px: 2.5,
          textAlign: 'center'
        }}
      >
        <Box sx={{ maxWidth: 260 }}>
          <DirectoryTreeIcon sx={{ fontSize: 28, color: 'text.disabled', mb: 1 }} />
          <Typography variant="body2" sx={{ fontWeight: 800 }}>
            还没有工作空间
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            选择项目会话后显示当前工作路径的文件树。
          </Typography>
        </Box>
      </Box>
    )
  }

  return (
    <ProjectFileTree
      key={`${rootPath}:${treeRevision}`}
      rootPath={rootPath}
      activePath={activePath ?? rootPath}
      onOpenFile={onOpenFile}
      onListDirectory={onListDirectory}
      variant="standalone"
    />
  )
}

export function WorkspaceSidePanel({
  width,
  slots,
  maximized,
  singleVisibleMode = null,
  onCloseSlot,
  onToggleMaximized,
  renderSlot
}: {
  width: number | string
  slots: WorkspaceSidePanelMode[]
  maximized: WorkspaceSidePanelMode | null
  singleVisibleMode?: WorkspaceSidePanelMode | null
  onCloseSlot: (mode: WorkspaceSidePanelMode) => void
  onToggleMaximized: (mode: WorkspaceSidePanelMode) => void
  renderSlot: (
    mode: WorkspaceSidePanelMode,
    context: WorkspaceSidePanelSlotRenderContext
  ) => ReactNode
}): React.JSX.Element {
  const selectedMode = maximized ?? singleVisibleMode
  const visibleSlots = selectedMode ? slots.filter((mode) => mode === selectedMode) : slots
  return (
    <Box
      data-phi-workspace-tools-side-panel="true"
      data-phi-workspace-side-panel-modes={slots.join(',')}
      data-phi-workspace-side-panel-maximized={maximized ?? undefined}
      sx={{
        width,
        height: '100vh',
        maxHeight: '100vh',
        boxSizing: 'border-box',
        flexShrink: 0,
        display: 'flex',
        minHeight: 0,
        flexDirection: 'column',
        gap: 1,
        py: 1,
        pr: 1,
        bgcolor: 'background.default'
      }}
    >
      {visibleSlots.map((mode, index) => {
        const actions = (
          <WorkspaceSidePanelSlotActions
            mode={mode}
            maximized={maximized === mode}
            showLayoutAction={maximized !== null || visibleSlots.length > 1}
            onToggleMaximized={() => onToggleMaximized(mode)}
            onClose={() => onCloseSlot(mode)}
          />
        )
        return (
          <Box
            key={mode}
            data-phi-workspace-side-panel-slot={mode}
            role="region"
            aria-label={workspacePanelLabels[mode]}
            sx={{
              flex: visibleSlots.length === 1 ? '1 1 0' : index === 0 ? '3 1 0' : '2 1 0',
              minWidth: 0,
              minHeight: visibleSlots.length === 1 ? 0 : 240,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              border: 1,
              borderColor: 'divider',
              borderRadius: '16px',
              bgcolor: 'background.paper'
            }}
          >
            {mode === 'browser' ? (
              renderSlot(mode, { headerActions: actions })
            ) : (
              <>
                <WorkspaceSidePanelSlotHeader mode={mode} actions={actions} />
                <Box sx={{ flex: 1, minHeight: 0, display: 'flex', p: mode === 'jobs' ? 1.5 : 0 }}>
                  {mode === 'terminal'
                    ? (renderSlot(mode, { headerActions: actions }) ?? (
                        <WorkspaceToolCard kind="terminal" label="终端" Icon={TerminalIcon} />
                      ))
                    : renderSlot(mode, { headerActions: actions })}
                </Box>
              </>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
