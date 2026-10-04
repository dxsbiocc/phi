import type { ReactNode } from 'react'
import { Box, Typography } from '@mui/material'
import { PhiIcons } from '../icons'
import type { WorkspaceSidePanelMode } from '../lib/workspaceSidePanelMode'
import type { DirectoryListing } from '../types'
import { ProjectFileTree } from '../features/file-preview/components/ProjectFileTree'

const DirectoryTreeIcon = PhiIcons.entity.directoryTree

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
  mode = 'terminal',
  children
}: {
  width: number | string
  mode?: WorkspaceSidePanelMode
  children?: ReactNode
}): React.JSX.Element {
  return (
    <Box
      data-phi-workspace-tools-side-panel={mode !== 'jobs' ? 'true' : undefined}
      data-phi-workspace-side-panel-mode={mode}
      sx={{
        width,
        flexShrink: 0,
        borderLeft: 1,
        borderColor: 'divider',
        display: 'flex',
        minHeight: 0,
        flexDirection: 'column',
        gap: mode === 'jobs' ? 1 : 0,
        px: mode === 'jobs' ? 1.5 : 0,
        pt: 6,
        pb: mode === 'jobs' ? 1.5 : 0,
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF'
      }}
    >
      {children}
    </Box>
  )
}
