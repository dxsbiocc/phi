import { Box, Tooltip, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { PhiIcons, directoryIconForPath } from '../../../icons'
import { FileTreeLoadingIndicator } from './FileTreeStatusRows'
import { FILE_TREE_TOOLTIP_DELAY_MS } from '../lib/fileTreeActions'

const CollapseIcon = PhiIcons.action.expand
const ExpandIcon = PhiIcons.action.back

export function FileTreeRootRow({
  rootPath,
  rootName,
  rootDisplayPath,
  isExpanded,
  isActive,
  isLoading = false,
  localDropTargetPath,
  onToggle
}: {
  rootPath: string
  rootName: string
  rootDisplayPath: string
  isExpanded: boolean
  isActive: boolean
  isLoading?: boolean
  localDropTargetPath?: string
  onToggle: () => void
}): React.JSX.Element {
  const RootChevronIcon = isExpanded ? CollapseIcon : ExpandIcon
  const rootIcon = directoryIconForPath(rootPath, isExpanded, true)
  const RootFolderIcon = rootIcon.Icon

  return (
    <Tooltip
      title={rootDisplayPath}
      placement="top-start"
      enterDelay={FILE_TREE_TOOLTIP_DELAY_MS}
      enterNextDelay={FILE_TREE_TOOLTIP_DELAY_MS}
      disableInteractive
    >
      <Box
        component="button"
        type="button"
        data-phi-file-tree-root="true"
        data-phi-file-kind="directory"
        data-phi-file-drop-target={localDropTargetPath ? 'remote-file-tree' : undefined}
        data-phi-file-drop-path={localDropTargetPath}
        aria-expanded={isExpanded}
        aria-busy={isLoading || undefined}
        onClick={onToggle}
        sx={{
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
          minHeight: 34,
          px: 1,
          py: 0.45,
          border: 0,
          borderRadius: 1,
          bgcolor: (theme) => (isActive ? alpha(theme.palette.primary.main, 0.1) : 'transparent'),
          color: isActive ? 'primary.main' : 'text.primary',
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          '&:hover': {
            bgcolor: (theme) =>
              isActive
                ? alpha(theme.palette.primary.main, 0.13)
                : alpha(theme.palette.text.primary, 0.055)
          },
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: -2
          }
        }}
      >
        <RootChevronIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        <RootFolderIcon fontSize="small" sx={{ color: rootIcon.color }} />
        <Typography
          variant="body2"
          sx={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: isActive ? 700 : 500
          }}
        >
          {rootName}
        </Typography>
        {isLoading && <FileTreeLoadingIndicator label={rootName} />}
      </Box>
    </Tooltip>
  )
}
