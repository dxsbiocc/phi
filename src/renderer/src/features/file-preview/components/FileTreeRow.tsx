import { Box, IconButton, Tooltip, Typography } from '@mui/material'
import type { KeyboardEvent, MouseEvent } from 'react'
import { alpha } from '@mui/material/styles'
import {
  PhiIcons,
  directoryIconForPath,
  fileIconForPath,
  genericDirectoryIcon
} from '../../../icons'
import type { FileTreeEntry } from '../../../types'
import { FILE_TREE_TOOLTIP_DELAY_MS, fileTreeDisplayPath } from '../lib/fileTreeActions'
import { FileTreeLoadingIndicator } from './FileTreeStatusRows'

const CollapseIcon = PhiIcons.action.expand
const ExpandIcon = PhiIcons.action.back

export function FileTreeRow({
  entry,
  depth,
  isExpanded,
  isActive,
  isLoading = false,
  genericDirectoryIcons = false,
  localDropTargetPath,
  onClick,
  onContextMenu,
  onKeyDown,
  onDownload
}: {
  entry: FileTreeEntry
  depth: number
  isExpanded: boolean
  isActive: boolean
  isLoading?: boolean
  genericDirectoryIcons?: boolean
  localDropTargetPath?: string
  onClick: () => void
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
  onDownload?: () => void
}): React.JSX.Element {
  const isDirectory = entry.kind === 'directory'
  const entryIcon = isDirectory
    ? genericDirectoryIcons
      ? genericDirectoryIcon(isExpanded)
      : directoryIconForPath(entry.path, isExpanded)
    : fileIconForPath(entry.path)
  const EntryIcon = entryIcon.Icon
  const ChevronIcon = isExpanded ? CollapseIcon : ExpandIcon
  const extension = !isDirectory && entry.name.includes('.') ? entry.name.split('.').pop() : ''
  const tooltip = (
    <Box sx={{ maxWidth: 420, overflowWrap: 'anywhere' }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {entry.name}
      </Typography>
      <Typography variant="caption" component="div" sx={{ opacity: 0.8, mt: 0.25 }}>
        {isDirectory ? '文件夹' : extension ? `${extension.toUpperCase()} 文件` : '文件'}
        {entry.path.startsWith('ssh://') ? ' · 远程' : ''}
      </Typography>
      <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>
        {fileTreeDisplayPath(entry)}
      </Typography>
    </Box>
  )

  return (
    <Box
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      sx={{
        display: 'flex',
        alignItems: 'center',
        minWidth: 0,
        width: '100%',
        borderRadius: 1,
        bgcolor: (theme) => (isActive ? alpha(theme.palette.primary.main, 0.1) : 'transparent'),
        '&:hover': {
          bgcolor: (theme) =>
            isActive
              ? alpha(theme.palette.primary.main, 0.13)
              : alpha(theme.palette.text.primary, 0.055)
        },
        '&:hover .phi-file-download': {
          opacity: 1,
          pointerEvents: 'auto'
        }
      }}
    >
      <Tooltip
        title={tooltip}
        placement="top-start"
        enterDelay={FILE_TREE_TOOLTIP_DELAY_MS}
        enterNextDelay={FILE_TREE_TOOLTIP_DELAY_MS}
        disableInteractive
      >
        <Box
          component="button"
          type="button"
          data-phi-file-kind={entryIcon.kind}
          data-phi-file-path={entry.path}
          data-phi-file-drop-target={localDropTargetPath ? 'remote-file-tree' : undefined}
          data-phi-file-drop-path={localDropTargetPath}
          aria-current={isActive ? 'location' : undefined}
          aria-busy={isLoading || undefined}
          onClick={onClick}
          sx={{
            flex: 1,
            maxWidth: '100%',
            minWidth: 0,
            boxSizing: 'border-box',
            minHeight: 32,
            px: 1,
            py: 0.45,
            pl: 1 + depth * 1.75,
            border: 0,
            borderRadius: 1,
            bgcolor: 'transparent',
            color: isActive ? 'primary.main' : 'text.primary',
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: -2
            }
          }}
        >
          {isDirectory ? (
            <ChevronIcon fontSize="small" sx={{ color: 'text.secondary' }} />
          ) : (
            <Box sx={{ width: '1.25rem', flexShrink: 0 }} />
          )}
          <EntryIcon
            fontSize="small"
            sx={{ color: entryIcon.color, opacity: isDirectory ? 0.9 : 1 }}
          />
          <Typography
            variant="body2"
            sx={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: entry.name.startsWith('.') ? 'var(--font-mono)' : undefined
            }}
          >
            {entry.name}
          </Typography>
          {isLoading && <FileTreeLoadingIndicator label={entry.name} />}
        </Box>
      </Tooltip>
      {onDownload && (
        <Tooltip
          title="下载远程文件"
          disableFocusListener
          enterDelay={FILE_TREE_TOOLTIP_DELAY_MS}
          enterNextDelay={FILE_TREE_TOOLTIP_DELAY_MS}
        >
          <IconButton
            size="small"
            className="phi-file-download"
            aria-label={`下载 ${entry.name}`}
            onClick={onDownload}
            sx={{
              opacity: 0,
              pointerEvents: 'none',
              width: 26,
              height: 26,
              mr: 0.5,
              flexShrink: 0,
              color: 'text.secondary',
              '@media (hover: none)': { opacity: 1, pointerEvents: 'auto' }
            }}
          >
            <PhiIcons.action.download sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  )
}
