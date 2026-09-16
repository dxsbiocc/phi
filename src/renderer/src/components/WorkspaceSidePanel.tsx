import { Box, Divider, Typography } from '@mui/material'
import { PhiIcons } from '../icons'
import type { DirectoryListing } from '../types'
import { ProjectFileTree } from '../features/file-preview/components/ProjectFileTree'

export type WorkspaceSidePanelTab = 'files'

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
  treeRevision = 0,
  titlebarInsetEnd = 15,
  workspaceRootPath,
  activeWorkspacePath,
  onOpenWorkspaceFile,
  onListWorkspaceDirectory
}: {
  width: number | string
  treeRevision?: number
  titlebarInsetEnd?: number | string
  workspaceRootPath?: string | null
  activeWorkspacePath?: string | null
  onOpenWorkspaceFile?: (path: string) => void
  onListWorkspaceDirectory?: (path: string) => Promise<DirectoryListing>
}): React.JSX.Element {
  return (
    <Box
      sx={{
        width,
        flexShrink: 0,
        borderLeft: 1,
        borderColor: 'divider',
        display: 'flex',
        minHeight: 0,
        flexDirection: 'column',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF'
      }}
    >
      <Box
        data-phi-workspace-explorer-header="true"
        sx={{
          minHeight: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          pl: 1.5,
          pr: titlebarInsetEnd
        }}
      >
        <DirectoryTreeIcon sx={{ fontSize: 18, color: 'text.secondary', flexShrink: 0 }} />
        <Typography
          variant="button"
          sx={{ flex: 1, minWidth: 0, fontSize: '0.78rem', fontWeight: 850 }}
          noWrap
        >
          Workspace
        </Typography>
      </Box>
      <Divider />
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <WorkspaceFilesPane
          rootPath={workspaceRootPath}
          activePath={activeWorkspacePath}
          treeRevision={treeRevision}
          onOpenFile={onOpenWorkspaceFile}
          onListDirectory={onListWorkspaceDirectory}
        />
      </Box>
    </Box>
  )
}
