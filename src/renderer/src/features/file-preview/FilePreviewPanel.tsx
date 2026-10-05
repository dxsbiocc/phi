import { Box, IconButton, Tooltip, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { useEffect, useState } from 'react'
import { PhiIcons, fileIconForPath } from '../../icons'
import type { DirectoryListing } from '../../types'
import { isOfficeDocumentPath } from '../../lib/officeDocumentPath'
import { OfficePanel } from '../office/OfficePanel'
import { OfficeImportAction } from '../office/components/OfficeImportAction'
import { FilePreviewBody } from './components/FilePreviewBody'
import { ResultDownloadStatus } from './components/ResultDownloadStatus'
import {
  defaultAppIconMode,
  previewDisplayPath,
  previewFullPath,
  previewIconForState,
  previewRootLabel,
  previewTitle,
  type FilePreviewPanelState
} from './lib/filePreviewState'
import type { FileDownloadState } from './lib/filePreviewState'

export type { FilePreviewPanelState } from './lib/filePreviewState'
export { ProjectFileTree } from './components/ProjectFileTree'

const CloseIcon = PhiIcons.action.close
const BreadcrumbSeparatorIcon = PhiIcons.action.back
const DefaultOpenIcon = PhiIcons.action.openDefault
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
  onOpenDefaultPath: (path: string, kind?: 'file' | 'directory') => void
  onRevealPath: (path: string, kind?: 'file' | 'directory') => void
  onListDirectory: (path: string) => Promise<DirectoryListing>
  onDownloadFile?: (path: string) => void
  downloadState?: FileDownloadState | null
  onCancelDownload?: () => void
}

function fileManagerLabel(): string {
  if (typeof window !== 'undefined' && window.platform === 'darwin') return 'Finder 中显示'
  if (typeof window !== 'undefined' && window.platform === 'win32') return '资源管理器中显示'
  return '文件管理器中显示'
}

function officePreviewEnabled(): boolean {
  return typeof window !== 'undefined' && window.api?.office?.enabled === true
}

export function FilePreviewTitleTab({
  state,
  onClose,
  titlebarInsetStart = 1.25,
  titlebarInsetEnd = 1.25
}: {
  state: FilePreviewPanelState
  onClose: () => void
  titlebarInsetStart?: number | string
  titlebarInsetEnd?: number | string
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
        pl: titlebarInsetStart,
        pr: titlebarInsetEnd,
        WebkitAppRegion: 'drag'
      }}
    >
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
        <Tooltip title={path} placement="top-start" arrow slotProps={pathTooltipSlotProps}>
          <Typography
            variant="subtitle2"
            sx={{
              minWidth: 0,
              maxWidth: 'calc(100% - 48px)',
              display: 'inline-block',
              fontWeight: 700,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {title}
          </Typography>
        </Tooltip>
        <IconButton
          size="small"
          aria-label="关闭文件预览"
          onClick={onClose}
          sx={{ ml: 0.25, p: 0.35, flexShrink: 0 }}
        >
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>
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
            <BreadcrumbSeparatorIcon sx={{ fontSize: 16, color: 'text.disabled', flexShrink: 0 }} />
          ) : null}
          <Tooltip title={fullPath} placement="top-start" arrow slotProps={pathTooltipSlotProps}>
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
          </Tooltip>
        </Box>
      ))}
    </Box>
  )
}

function FilePreviewActions({
  path,
  pathKind,
  onOpenDefaultPath,
  onRevealPath,
  onDownloadFile,
  showDownloadAction
}: {
  path: string
  pathKind: 'file' | 'directory'
  onOpenDefaultPath: (path: string, kind?: 'file' | 'directory') => void
  onRevealPath: (path: string, kind?: 'file' | 'directory') => void
  onDownloadFile?: (path: string) => void
  showDownloadAction?: boolean
}): React.JSX.Element {
  const isRemote = path.startsWith('ssh://')
  const revealLabel = fileManagerLabel()
  const iconMode = defaultAppIconMode(path, pathKind)
  const extensionIcon = iconMode === 'extension' ? fileIconForPath(path) : null
  const ExtensionIcon = extensionIcon?.Icon
  const [defaultAppIcon, setDefaultAppIcon] = useState<{ path: string; src: string | null } | null>(
    null
  )
  const defaultAppIconSrc = defaultAppIcon?.path === path ? defaultAppIcon.src : null

  useEffect(() => {
    let active = true

    if (
      isRemote ||
      iconMode === 'extension' ||
      typeof window === 'undefined' ||
      typeof window.api?.getFileIcon !== 'function'
    ) {
      return () => {
        active = false
      }
    }

    void window.api
      .getFileIcon(path)
      .then((iconSrc) => {
        if (active) setDefaultAppIcon({ path, src: iconSrc })
      })
      .catch(() => {
        if (active) setDefaultAppIcon({ path, src: null })
      })

    return () => {
      active = false
    }
  }, [iconMode, isRemote, path])

  if (isRemote) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.35, flexShrink: 0 }}>
        <Tooltip title="复制远程路径" enterDelay={400}>
          <IconButton
            size="small"
            aria-label="复制远程路径"
            onClick={() => {
              void navigator.clipboard.writeText(path).catch((error) => {
                console.error('Failed to copy remote path:', error)
              })
            }}
          >
            <PhiIcons.action.copy sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="在文件面板打开" enterDelay={400}>
          <IconButton
            size="small"
            aria-label="在文件面板打开"
            onClick={() => onOpenDefaultPath(path, pathKind)}
          >
            <DefaultOpenIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="在项目文件中定位" enterDelay={400}>
          <IconButton
            size="small"
            aria-label="在项目文件中定位"
            onClick={() => onRevealPath(path, pathKind)}
          >
            <FolderIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
        {showDownloadAction && onDownloadFile ? (
          <Tooltip title="下载到本机" enterDelay={400}>
            <IconButton size="small" aria-label="下载远程文件" onClick={() => onDownloadFile(path)}>
              <PhiIcons.action.download sx={{ fontSize: 17 }} />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.35, flexShrink: 0 }}>
      <Tooltip title="默认应用打开" enterDelay={400}>
        <IconButton
          size="small"
          aria-label="默认应用打开"
          data-phi-file-open-default-button="true"
          onClick={() => onOpenDefaultPath(path, pathKind)}
          sx={{
            width: 34,
            height: 30,
            border: 1,
            borderColor: 'divider',
            borderRadius: 2,
            color: 'primary.main',
            '&:hover': {
              borderColor: 'primary.main',
              bgcolor: (theme) =>
                alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.1)
            }
          }}
        >
          {defaultAppIconSrc ? (
            <Box
              component="img"
              src={defaultAppIconSrc}
              alt=""
              aria-hidden="true"
              data-phi-file-open-default-app-icon="system"
              sx={{
                width: 18,
                height: 18,
                objectFit: 'contain',
                flexShrink: 0
              }}
            />
          ) : ExtensionIcon && extensionIcon ? (
            <ExtensionIcon
              data-phi-file-open-default-app-icon="extension"
              sx={{ flexShrink: 0, fontSize: 18, color: extensionIcon.color }}
            />
          ) : (
            <DefaultOpenIcon sx={{ fontSize: 17 }} />
          )}
        </IconButton>
      </Tooltip>
      <Tooltip title={revealLabel} enterDelay={400}>
        <IconButton
          size="small"
          aria-label={revealLabel}
          data-phi-file-reveal-button="true"
          onClick={() => onRevealPath(path, pathKind)}
          sx={{
            width: 34,
            height: 30,
            borderRadius: 2,
            color: 'text.secondary',
            '&:hover': {
              bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08),
              color: 'text.primary'
            }
          }}
        >
          <FolderIcon sx={{ fontSize: 17 }} />
        </IconButton>
      </Tooltip>
    </Box>
  )
}

export default function FilePreviewPanel({
  state,
  layout = 'sidecar',
  onOpenFile,
  onOpenDefaultPath,
  onRevealPath,
  onListDirectory,
  onDownloadFile,
  downloadState,
  onCancelDownload
}: FilePreviewPanelProps): React.JSX.Element {
  const path = previewFullPath(state)
  const displayPath = previewDisplayPath(state)
  const rootLabel = previewRootLabel(state)
  const previewIcon = previewIconForState(state)
  const isDirectoryState = state.status === 'directory'
  const availableDownload = downloadState?.status === 'running' ? undefined : onDownloadFile
  const isOfficePreview = officePreviewEnabled() && isOfficeDocumentPath(path)
  const officeBridge = typeof window !== 'undefined' ? window.api?.office : undefined

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
        <FilePreviewActions
          path={path}
          pathKind={isDirectoryState ? 'directory' : 'file'}
          onOpenDefaultPath={onOpenDefaultPath}
          onRevealPath={onRevealPath}
          onDownloadFile={availableDownload}
          showDownloadAction={state.status === 'ready' && state.file.kind !== 'metadata'}
        />
      </Box>

      {officeBridge ? (
        <OfficeImportAction bridge={officeBridge} sourcePath={path} onImported={onOpenFile} />
      ) : null}

      <ResultDownloadStatus state={downloadState} onCancel={onCancelDownload} />

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
          {isOfficePreview ? (
            <OfficePanel key={path} sourcePath={path} />
          ) : (
            <FilePreviewBody
              state={state}
              onOpenFile={onOpenFile}
              onListDirectory={onListDirectory}
              onDownloadFile={availableDownload}
            />
          )}
        </Box>
      </Box>
    </Box>
  )
}
