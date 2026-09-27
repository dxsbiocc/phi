import { Box, Tooltip } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { useState } from 'react'

import { directoryIconForPath, fileIconForPath } from '../../icons'
import { remotePathInsideRoot, remoteWorkspaceUri } from '../../../../shared/remoteWorkspacePath'
import { useRemoteProjectFileContext } from '../../lib/remoteProjectFileContext'
import { localPathLabel, type LocalPathKind } from '../../lib/markdownLocalPathReferences'
import {
  HOVER_PREVIEW_OPEN_DELAY_MS,
  localPathTooltipSlotProps
} from '../../lib/markdownLocalPathPreview'
import { LocalFileHoverPreview } from './MarkdownHoverPreview'

export function LocalPathButton({
  text,
  absolutePath,
  pathKind = 'file',
  onOpenLocalPath
}: {
  text: string
  absolutePath: string
  pathKind?: LocalPathKind
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void
}): React.JSX.Element {
  const remoteProject = useRemoteProjectFileContext()
  const remoteUri =
    remoteProject?.hostAlias && remotePathInsideRoot(absolutePath, remoteProject.canonicalRoot)
      ? remoteWorkspaceUri(remoteProject.hostAlias, absolutePath)
      : null
  const label = localPathLabel(text, absolutePath)
  const pathIcon =
    pathKind === 'directory' ? directoryIconForPath(absolutePath) : fileIconForPath(absolutePath)
  const LocalFileIcon = pathIcon.Icon
  const supportsHoverPreview = pathKind === 'file' && !remoteProject
  const [hoverPreviewActive, setHoverPreviewActive] = useState(false)
  const button = (
    <Tooltip
      title={
        supportsHoverPreview ? (
          <LocalFileHoverPreview absolutePath={absolutePath} shouldLoad={hoverPreviewActive} />
        ) : (
          (remoteUri ?? absolutePath)
        )
      }
      placement="top-start"
      arrow
      slotProps={localPathTooltipSlotProps}
      enterDelay={HOVER_PREVIEW_OPEN_DELAY_MS}
      leaveDelay={80}
      onOpen={() => {
        if (supportsHoverPreview) setHoverPreviewActive(true)
      }}
      onClose={() => {
        if (supportsHoverPreview) setHoverPreviewActive(false)
      }}
    >
      <Box
        component="button"
        type="button"
        data-phi-slot={remoteProject ? 'remote-file-link' : 'local-file-link'}
        data-phi-file-kind={pathIcon.kind}
        data-phi-path={remoteUri ?? absolutePath}
        aria-label={`${pathKind === 'directory' ? '打开目录' : '打开文件'} ${absolutePath}`}
        onClick={() => {
          if (remoteProject) {
            if (remoteUri) remoteProject.openPath(remoteUri, pathKind)
            return
          }
          if (onOpenLocalPath) {
            onOpenLocalPath(absolutePath, pathKind)
            return
          }

          void window.api.revealPath(absolutePath).catch((error) => {
            console.error('Failed to reveal local path:', error)
          })
        }}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.45,
          maxWidth: '100%',
          minWidth: 0,
          px: 0.25,
          py: 0,
          mx: 0.1,
          border: 0,
          borderRadius: 0.75,
          bgcolor: 'transparent',
          color: 'primary.main',
          font: 'inherit',
          fontWeight: 500,
          lineHeight: 'inherit',
          verticalAlign: 'baseline',
          cursor: 'pointer',
          overflowWrap: 'normal',
          textDecoration: 'none',
          '&:hover': {
            bgcolor: (theme) => alpha(theme.palette.primary.main, 0.08),
            color: 'primary.dark'
          },
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2
          }
        }}
      >
        <LocalFileIcon fontSize="inherit" sx={{ color: pathIcon.color, fontSize: '1em' }} />
        <Box
          component="span"
          sx={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {label}
        </Box>
      </Box>
    </Tooltip>
  )

  if (!supportsHoverPreview) return button

  return (
    <Box
      component="span"
      data-phi-slot="local-file-hover-preview"
      data-phi-hover-preview-path={absolutePath}
      sx={{
        display: 'inline',
        maxWidth: '100%',
        minWidth: 0
      }}
    >
      {button}
    </Box>
  )
}
