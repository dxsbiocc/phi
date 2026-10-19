import { Box, Typography } from '@mui/material'
import { alpha, type SxProps, type Theme } from '@mui/material/styles'
import type { MouseEvent } from 'react'

import type { ResourceIconRef } from '../../../../shared/resourceIconTypes'
import { ConnectorIcon } from '../../features/mcp/components/ConnectorIcon'
import { directoryIconForPath, fileIconForPath, PhiIcons } from '../../icons'
import { appCopy } from '../../lib/appCopy'
import { useUiLanguage } from '../../lib/i18n'
import { WINDOW_TITLEBAR_HEIGHT } from '../../lib/windowChromeLayout'
import type {
  WorkspaceFileWorkspaceTab,
  WorkspaceSessionTab,
  WorkspaceTab
} from '../../lib/workspaceResourceTabs'
import type { WorkspaceFileTab } from '../../useWorkspaceFileTabs'
import { WorkspaceResourceTabs } from '../WorkspaceResourceTabs'

/**
 * Shared with App.tsx so the trailing titlebar toggles keep their reserved
 * space in sync with the controls that actually paint them.
 */
export const titlebarTrailingToggleChromeReserve = '120px'

const titlebarHeaderSx = {
  height: WINDOW_TITLEBAR_HEIGHT,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  WebkitAppRegion: 'drag'
} as const

function titlebarHeaderPadding(
  leadingChromeInset: number,
  reserveTrailingChromeSpace: boolean
): { pl: string | number; pr: string | number } {
  return {
    pl: leadingChromeInset > 0 ? `${leadingChromeInset}px` : 1.5,
    pr: reserveTrailingChromeSpace ? titlebarTrailingToggleChromeReserve : 1.5
  }
}

function fileTabSx(selected: boolean): SxProps<Theme> {
  return {
    border: 1,
    borderColor: selected
      ? (theme) => alpha(theme.palette.primary.main, 0.5)
      : (theme) => alpha(theme.palette.text.primary, 0.12),
    borderRadius: '999px',
    bgcolor: selected
      ? (theme) => alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.1)
      : (theme) => alpha(theme.palette.background.paper, 0.56),
    color: selected ? 'text.primary' : 'text.secondary',
    cursor: selected ? 'default' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 0.4,
    flex: '0 0 156px',
    width: 156,
    minWidth: 118,
    maxWidth: 156,
    height: 32,
    px: 0.6,
    pl: 1,
    lineHeight: 1,
    WebkitAppRegion: 'no-drag',
    '&:hover': {
      bgcolor: selected
        ? (theme) => alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.24 : 0.14)
        : (theme) => alpha(theme.palette.action.hover, 0.68),
      color: 'text.primary'
    },
    '&:hover .workspace-file-tab-close, &:focus-within .workspace-file-tab-close': {
      opacity: 1
    }
  }
}

function fileTabCloseSx(selected: boolean): SxProps<Theme> {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 17,
    height: 17,
    ml: 'auto',
    borderRadius: '50%',
    color: 'text.disabled',
    opacity: selected ? 0.72 : 0,
    transition: 'opacity 120ms ease, background-color 120ms ease, color 120ms ease',
    WebkitAppRegion: 'no-drag',
    '&:hover': {
      bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08),
      color: 'text.primary'
    }
  }
}

function activateFileTab(
  tab: WorkspaceFileTab,
  selected: boolean,
  onSelect: (tab: WorkspaceFileTab) => void
): void {
  if (!selected) onSelect(tab)
}

function WorkspaceFileTabItem({
  tab,
  selected,
  onSelect,
  onClose
}: {
  tab: WorkspaceFileTab
  selected: boolean
  onSelect: (tab: WorkspaceFileTab) => void
  onClose: (tab: WorkspaceFileTab) => void
}): React.JSX.Element {
  const fileIcon =
    tab.kind === 'directory' ? directoryIconForPath(tab.path, selected) : fileIconForPath(tab.path)
  const FileIcon = fileIcon.Icon
  const activate = (): void => activateFileTab(tab, selected, onSelect)
  const close = (event: MouseEvent<HTMLElement>): void => {
    event.stopPropagation()
    onClose(tab)
  }
  return (
    <Box
      role="tab"
      tabIndex={0}
      aria-selected={selected}
      data-phi-workspace-file-tab={selected ? 'active' : 'inactive'}
      data-phi-workspace-file-kind={tab.kind}
      title={tab.absolutePath ?? tab.path}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        activate()
      }}
      sx={fileTabSx(selected)}
    >
      <FileIcon sx={{ flexShrink: 0, fontSize: 18, color: fileIcon.color }} />
      <Typography
        component="span"
        noWrap
        sx={{
          flex: 1,
          minWidth: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: '0.78rem',
          fontWeight: selected ? 800 : 650,
          lineHeight: '18px'
        }}
      >
        {tab.name}
      </Typography>
      {tab.dirty && (
        <Box
          component="span"
          role="img"
          aria-label={appCopy.unsaved}
          sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'warning.main' }}
        />
      )}
      <Box
        className="workspace-file-tab-close"
        component="span"
        role="button"
        aria-label={appCopy.closeTab(tab.name)}
        tabIndex={0}
        onClick={close}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          onClose(tab)
        }}
        sx={fileTabCloseSx(selected)}
      >
        <PhiIcons.action.close sx={{ fontSize: 14 }} />
      </Box>
    </Box>
  )
}

function WorkspaceFileTabs({
  tabs,
  activePath,
  onSelect,
  onClose
}: {
  tabs: WorkspaceFileTab[]
  activePath: string | null
  onSelect: (tab: WorkspaceFileTab) => void
  onClose: (tab: WorkspaceFileTab) => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Box
      role="tablist"
      aria-label={appCopy.openFiles}
      data-phi-workspace-file-tabs="true"
      sx={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.55,
        overflowX: 'auto',
        alignSelf: 'stretch',
        py: 0.65,
        WebkitAppRegion: 'drag',
        scrollbarWidth: 'none',
        '&::-webkit-scrollbar': { display: 'none' }
      }}
    >
      {tabs.map((tab) => (
        <WorkspaceFileTabItem
          key={tab.id}
          tab={tab}
          selected={tab.path === activePath}
          onSelect={onSelect}
          onClose={onClose}
        />
      ))}
    </Box>
  )
}

export function WorkspaceFileHeader({
  tabs,
  activePath,
  onSelect,
  onClose,
  leadingChromeInset = 0,
  reserveTrailingChromeSpace = false
}: {
  tabs: WorkspaceFileTab[]
  activePath: string | null
  onSelect: (tab: WorkspaceFileTab) => void
  onClose: (tab: WorkspaceFileTab) => void
  leadingChromeInset?: number
  reserveTrailingChromeSpace?: boolean
}): React.JSX.Element {
  return (
    <Box
      data-phi-workspace-file-header="true"
      sx={{
        ...titlebarHeaderSx,
        ...titlebarHeaderPadding(leadingChromeInset, reserveTrailingChromeSpace)
      }}
    >
      <WorkspaceFileTabs
        tabs={tabs}
        activePath={activePath}
        onSelect={onSelect}
        onClose={onClose}
      />
    </Box>
  )
}

function renderConnectorTabIcon(icon?: ResourceIconRef): React.JSX.Element {
  return <ConnectorIcon icon={icon} size={20} />
}

function renderFileWorkspaceTabIcon(tab: WorkspaceFileWorkspaceTab): React.JSX.Element {
  const icon =
    tab.kind === 'directory' ? directoryIconForPath(tab.path, false) : fileIconForPath(tab.path)
  const Icon = icon.Icon
  return <Icon sx={{ flexShrink: 0, fontSize: 18, color: icon.color }} />
}

export function WorkspaceResourceHeader({
  tabs,
  activeKey,
  onSelect,
  onClose,
  onDockSessionTab,
  actions,
  leadingChromeInset = 0,
  reserveTrailingChromeSpace = false
}: {
  tabs: WorkspaceTab[]
  activeKey: string | null
  onSelect: (tab: WorkspaceTab) => void
  onClose: (tab: WorkspaceTab) => void
  onDockSessionTab?: (tab: WorkspaceSessionTab) => void
  actions?: React.ReactNode
  leadingChromeInset?: number
  reserveTrailingChromeSpace?: boolean
}): React.JSX.Element {
  return (
    <Box
      data-phi-workspace-resource-header="true"
      sx={{
        ...titlebarHeaderSx,
        ...titlebarHeaderPadding(leadingChromeInset, reserveTrailingChromeSpace)
      }}
    >
      <WorkspaceResourceTabs
        tabs={tabs}
        activeKey={activeKey}
        onSelect={onSelect}
        onClose={onClose}
        onDockSessionTab={onDockSessionTab}
        connectorIcon={renderConnectorTabIcon}
        fileIcon={renderFileWorkspaceTabIcon}
      />
      {actions}
    </Box>
  )
}
