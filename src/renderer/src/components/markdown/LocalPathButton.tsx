import { Box, Tooltip } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { directoryIconForPath, fileIconForPath, PhiIcons } from '../../icons'
import { remotePathInsideRoot, remoteWorkspaceUri } from '../../../../shared/remoteWorkspacePath'
import { useRemoteProjectFileContext } from '../../lib/remoteProjectFileContext'
import { localPathLabel, type LocalPathKind } from '../../lib/markdownLocalPathReferences'
import { InlineLinkMenu, type InlineLinkMenuAction } from './InlineLinkMenu'
import {
  inlineLinkLabelSx,
  inlineLinkTooltipSlotProps,
  useInlineLinkMenu
} from './useInlineLinkMenu'

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
  const target = remoteUri ?? absolutePath
  const interactions = useInlineLinkMenu(target)
  const reveal = (): Promise<void> => window.api.revealPath(absolutePath)
  const openPath = (): void | Promise<void> => {
    if (remoteProject) {
      if (remoteUri) remoteProject.openPath(remoteUri, pathKind)
      return
    }
    if (onOpenLocalPath) {
      onOpenLocalPath(absolutePath, pathKind)
      return
    }
    return reveal()
  }
  const actions: InlineLinkMenuAction[] = [
    {
      id: 'open',
      label:
        remoteProject || onOpenLocalPath
          ? pathKind === 'directory'
            ? '打开目录'
            : '打开文件'
          : '在文件管理器中显示',
      icon: <LocalFileIcon sx={{ fontSize: 16 }} />,
      disabled: Boolean(remoteProject && !remoteUri),
      onSelect: openPath
    },
    ...(!remoteProject && onOpenLocalPath
      ? [
          {
            id: 'reveal',
            label: '在文件管理器中显示',
            icon: <PhiIcons.entity.folder sx={{ fontSize: 16 }} />,
            onSelect: reveal
          }
        ]
      : []),
    {
      id: 'copy-path',
      label: '复制路径',
      icon: <PhiIcons.action.copy sx={{ fontSize: 16 }} />,
      onSelect: () => navigator.clipboard.writeText(target)
    },
    {
      id: 'copy-name',
      label: pathKind === 'directory' ? '复制目录名' : '复制文件名',
      icon: <PhiIcons.action.copy sx={{ fontSize: 16 }} />,
      onSelect: () => navigator.clipboard.writeText(localPathLabel('', absolutePath))
    }
  ]

  return (
    <>
      <Tooltip
        describeChild
        title={target}
        placement="top-start"
        arrow
        slotProps={inlineLinkTooltipSlotProps}
        enterDelay={350}
        leaveDelay={80}
        {...interactions.tooltip}
      >
        <Box
          component="button"
          type="button"
          data-phi-slot={remoteProject ? 'remote-file-link' : 'local-file-link'}
          data-phi-file-kind={pathIcon.kind}
          data-phi-path={remoteUri ?? absolutePath}
          aria-haspopup="menu"
          aria-controls={interactions.position ? interactions.menuId : undefined}
          aria-expanded={interactions.position !== null}
          onContextMenu={interactions.onContextMenu}
          onKeyDown={interactions.onKeyDown}
          aria-label={`${pathKind === 'directory' ? '打开目录' : '打开文件'} ${absolutePath}`}
          onClick={() => {
            void Promise.resolve(openPath()).catch((error) => {
              console.error('Failed to open local path:', error)
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
          <Box component="span" sx={inlineLinkLabelSx}>
            {label}
          </Box>
        </Box>
      </Tooltip>
      <InlineLinkMenu
        id={interactions.menuId}
        kind="file"
        position={interactions.position}
        actions={actions}
        onClose={interactions.closeMenu}
      />
    </>
  )
}
