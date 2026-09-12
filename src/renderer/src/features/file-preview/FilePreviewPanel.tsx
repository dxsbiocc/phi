import { Box, Button, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { useState } from 'react'
import { PhiIcons } from '../../icons'
import type { DirectoryListing } from '../../types'
import { FilePreviewBody } from './components/FilePreviewBody'
import { ProjectFileTree } from './components/ProjectFileTree'
import {
  previewDisplayPath,
  previewFullPath,
  previewIconForState,
  previewRootLabel,
  previewTitle,
  previewTreeRootPath,
  type FilePreviewPanelState
} from './lib/filePreviewState'

export type { FilePreviewPanelState } from './lib/filePreviewState'
export { ProjectFileTree } from './components/ProjectFileTree'

const CloseIcon = PhiIcons.action.close
const CollapseIcon = PhiIcons.action.expand
const BreadcrumbSeparatorIcon = PhiIcons.action.back
const DefaultOpenIcon = PhiIcons.action.openDefault
const DirectoryTreeIcon = PhiIcons.entity.directoryTree
const FolderIcon = PhiIcons.entity.folder
const filePreviewPaneLayoutSx = {
  width: '66.666%',
  flexBasis: '66.666%',
  maxWidth: 'calc(100% - 320px)',
  minWidth: 320,
  flexShrink: 0
} as const
const pathTooltipSlotProps = {
  tooltip: {
    sx: {
      bgcolor: 'background.paper',
      border: 1,
      borderColor: 'divider',
      boxShadow: 3,
      color: 'text.primary',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.75rem',
      lineHeight: 1.45,
      maxWidth: 420,
      overflowWrap: 'anywhere'
    }
  },
  arrow: {
    sx: {
      color: 'background.paper',
      '&::before': {
        border: '1px solid',
        borderColor: 'divider',
        boxSizing: 'border-box'
      }
    }
  }
} as const

type FilePreviewPanelProps = {
  state: FilePreviewPanelState
  layout?: 'sidecar' | 'workspace'
  onOpenFile: (path: string) => void
  onOpenDefaultPath: (path: string) => void
  onRevealPath: (path: string) => void
  onListDirectory: (path: string) => Promise<DirectoryListing>
}

function fileManagerLabel(): string {
  if (typeof window !== 'undefined' && window.platform === 'darwin') return 'Finder 中显示'
  if (typeof window !== 'undefined' && window.platform === 'win32') return '资源管理器中显示'
  return '文件管理器中显示'
}

export function FilePreviewTitleTab({
  state,
  onClose
}: {
  state: FilePreviewPanelState
  onClose: () => void
}): React.JSX.Element {
  const title = previewTitle(state)
  const path = previewFullPath(state)
  const previewIcon = previewIconForState(state)
  const PreviewFileIcon = previewIcon.Icon
  const ariaLabel = previewIcon.kind === 'directory' ? '当前目录' : '当前文件'

  return (
    <Box
      sx={{
        ...filePreviewPaneLayoutSx,
        height: '100%',
        borderLeft: 1,
        borderColor: 'divider',
        display: 'flex',
        alignItems: 'center',
        px: 1.25,
        WebkitAppRegion: 'drag'
      }}
    >
      <Tooltip title={path} placement="top-start" arrow slotProps={pathTooltipSlotProps}>
        <Box
          role="tab"
          aria-selected="true"
          aria-label={`${ariaLabel}：${title}`}
          data-phi-file-kind={previewIcon.kind}
          sx={{
            height: 32,
            maxWidth: 'min(360px, 100%)',
            minWidth: 0,
            px: 1.15,
            borderRadius: 2,
            bgcolor: (theme) => alpha(theme.palette.text.primary, 0.055),
            color: 'text.primary',
            display: 'flex',
            alignItems: 'center',
            gap: 0.9,
            WebkitAppRegion: 'no-drag'
          }}
        >
          <PreviewFileIcon fontSize="small" sx={{ color: previewIcon.color, flexShrink: 0 }} />
          <Typography
            variant="subtitle2"
            sx={{
              flex: 1,
              minWidth: 0,
              fontWeight: 700,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {title}
          </Typography>
          <IconButton
            size="small"
            aria-label="关闭文件预览"
            onClick={onClose}
            sx={{ ml: 0.25, p: 0.35, flexShrink: 0 }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>
      </Tooltip>
    </Box>
  )
}

function FilePathBreadcrumb({
  rootLabel,
  displayPath,
  fullPath
}: {
  rootLabel: string
  displayPath: string
  fullPath: string
}): React.JSX.Element {
  const rawSegments = displayPath.split('/').filter(Boolean)
  const segments = rawSegments[0] === rootLabel ? rawSegments.slice(1) : rawSegments
  const items = [rootLabel, ...segments]
  const shownItems = items.length > 4 ? [items[0], '...', ...items.slice(-2)] : items

  return (
    <Tooltip title={fullPath} placement="top-start" arrow slotProps={pathTooltipSlotProps}>
      <Box
        aria-label={`文件路径：${items.join(' / ')}`}
        sx={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 0.65,
          color: 'text.secondary',
          overflow: 'hidden'
        }}
      >
        {shownItems.map((item, index) => (
          <Box
            key={`${item}-${index}`}
            component="span"
            sx={{
              minWidth: 0,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.65,
              flexShrink: index === shownItems.length - 1 ? 1 : 0
            }}
          >
            {index > 0 ? (
              <BreadcrumbSeparatorIcon
                sx={{ fontSize: 16, color: 'text.disabled', flexShrink: 0 }}
              />
            ) : null}
            <Typography
              component="span"
              variant="caption"
              sx={{
                minWidth: 0,
                maxWidth: index === shownItems.length - 1 ? '100%' : 140,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: index === shownItems.length - 1 ? 'text.primary' : 'text.secondary',
                fontWeight: index === shownItems.length - 1 ? 700 : 500
              }}
            >
              {item}
            </Typography>
          </Box>
        ))}
      </Box>
    </Tooltip>
  )
}

function OpenWithMenu({
  path,
  onOpenDefaultPath,
  onRevealPath
}: {
  path: string
  onOpenDefaultPath: (path: string) => void
  onRevealPath: (path: string) => void
}): React.JSX.Element {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const isOpen = Boolean(anchorEl)
  const revealLabel = fileManagerLabel()

  const close = (): void => setAnchorEl(null)
  const runAction = (action: (path: string) => void): void => {
    close()
    action(path)
  }

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={<DefaultOpenIcon sx={{ fontSize: 16 }} />}
        endIcon={<CollapseIcon sx={{ fontSize: 15 }} />}
        aria-label="打开方式"
        aria-haspopup="menu"
        aria-expanded={isOpen ? 'true' : undefined}
        onClick={(event) => setAnchorEl(event.currentTarget)}
        sx={{ minHeight: 30, px: 1.1, whiteSpace: 'nowrap' }}
      >
        打开
      </Button>
      <Menu anchorEl={anchorEl} open={isOpen} onClose={close} keepMounted>
        <MenuItem onClick={() => runAction(onOpenDefaultPath)}>
          <DefaultOpenIcon fontSize="small" sx={{ mr: 1 }} />
          默认应用
        </MenuItem>
        <MenuItem onClick={() => runAction(onRevealPath)}>
          <FolderIcon fontSize="small" sx={{ mr: 1 }} />
          {revealLabel}
        </MenuItem>
      </Menu>
    </>
  )
}

export default function FilePreviewPanel({
  state,
  layout = 'sidecar',
  onOpenFile,
  onOpenDefaultPath,
  onRevealPath,
  onListDirectory
}: FilePreviewPanelProps): React.JSX.Element {
  const [treeOpen, setTreeOpen] = useState(false)
  const path = previewFullPath(state)
  const displayPath = previewDisplayPath(state)
  const treeRootPath = previewTreeRootPath(state)
  const rootLabel = previewRootLabel(state)
  const previewIcon = previewIconForState(state)
  const isDirectoryState = state.status === 'directory'
  const treeToggleLabel = treeOpen ? '隐藏目录树' : '显示目录树'

  return (
    <Box
      component="aside"
      aria-label="文件预览"
      data-phi-file-kind={previewIcon.kind}
      data-phi-file-preview-layout={layout}
      sx={{
        ...(layout === 'workspace'
          ? {
              flex: 1,
              width: '100%',
              flexBasis: '100%',
              maxWidth: 'none',
              minWidth: 0
            }
          : filePreviewPaneLayoutSx),
        borderLeft: layout === 'workspace' ? 0 : 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0
      }}
    >
      <Box
        sx={{
          px: 1.5,
          py: 1,
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          flexShrink: 0
        }}
      >
        <FilePathBreadcrumb rootLabel={rootLabel} displayPath={displayPath} fullPath={path} />
        {isDirectoryState ? null : (
          <Tooltip title={treeToggleLabel} enterDelay={400}>
            <IconButton
              size="small"
              aria-label={treeToggleLabel}
              aria-pressed={treeOpen}
              onClick={() => setTreeOpen((open) => !open)}
              sx={(theme) => ({
                width: 34,
                height: 30,
                border: 1,
                borderColor: treeOpen ? 'primary.main' : 'divider',
                borderRadius: 2,
                color: treeOpen ? 'primary.main' : 'text.secondary',
                bgcolor: treeOpen
                  ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.1)
                  : 'transparent',
                '&:hover': {
                  borderColor: 'primary.main',
                  bgcolor: alpha(
                    theme.palette.primary.main,
                    theme.palette.mode === 'dark' ? 0.24 : 0.14
                  ),
                  color: 'primary.main'
                }
              })}
            >
              <DirectoryTreeIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        )}
        <OpenWithMenu
          path={path}
          onOpenDefaultPath={onOpenDefaultPath}
          onRevealPath={onRevealPath}
        />
      </Box>

      <Box
        data-phi-file-preview-content={isDirectoryState ? 'directory' : 'split'}
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex'
        }}
      >
        <Box
          data-phi-file-preview-pane={isDirectoryState ? 'directory' : 'file'}
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          <FilePreviewBody
            state={state}
            onOpenFile={onOpenFile}
            onListDirectory={onListDirectory}
          />
        </Box>
        {!isDirectoryState && treeOpen ? (
          <ProjectFileTree
            key={treeRootPath}
            rootPath={treeRootPath}
            activePath={path}
            onOpenFile={onOpenFile}
            onListDirectory={onListDirectory}
          />
        ) : null}
      </Box>
    </Box>
  )
}
