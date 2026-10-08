import { Box, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { PhiIcons } from '../icons'
import type { ResourceIconRef } from '../../../shared/resourceIconTypes'
import type {
  WorkspaceFileWorkspaceTab,
  WorkspaceTab,
  WorkspaceTabKind
} from '../lib/workspaceResourceTabs'

type ResourceIconComponent = typeof PhiIcons.nav.runtime

const resourceIcons: Record<WorkspaceTabKind, ResourceIconComponent> = {
  session: PhiIcons.nav.chat,
  file: PhiIcons.file.document,
  directory: PhiIcons.file.directory,
  notebook: PhiIcons.file.jupyter,
  runtime: PhiIcons.nav.runtime,
  plugins: PhiIcons.nav.plugins,
  skills: PhiIcons.nav.skills,
  mcp: PhiIcons.nav.mcp,
  wrappers: PhiIcons.nav.wrappers
}

export function WorkspaceResourceTabs({
  tabs,
  activeKey,
  onSelect,
  onClose,
  connectorIcon,
  fileIcon
}: {
  tabs: WorkspaceTab[]
  activeKey: string | null
  onSelect: (tab: WorkspaceTab) => void
  onClose: (tab: WorkspaceTab) => void
  connectorIcon?: (icon?: ResourceIconRef) => React.ReactNode
  fileIcon?: (tab: WorkspaceFileWorkspaceTab) => React.ReactNode
}): React.JSX.Element {
  return (
    <Box
      role="tablist"
      aria-label="Open resources"
      data-phi-workspace-resource-tabs="true"
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
      {tabs.map((tab) => {
        const selected = tab.key === activeKey
        const Icon = resourceIcons[tab.kind]
        return (
          <Box
            key={tab.key}
            role="tab"
            tabIndex={0}
            aria-selected={selected}
            data-phi-workspace-resource-tab={selected ? 'active' : 'inactive'}
            data-phi-workspace-resource-kind={tab.kind}
            title={tab.subtitle ?? tab.title}
            onClick={() => {
              if (!selected) onSelect(tab)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              if (!selected) onSelect(tab)
            }}
            sx={{
              border: 1,
              borderColor: selected
                ? (theme) => alpha(theme.palette.primary.main, 0.5)
                : (theme) => alpha(theme.palette.text.primary, 0.12),
              borderRadius: '999px',
              bgcolor: selected
                ? (theme) =>
                    alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.1)
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
                  ? (theme) =>
                      alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.24 : 0.14)
                  : (theme) => alpha(theme.palette.action.hover, 0.68),
                color: 'text.primary'
              },
              '& svg': {
                color: selected ? 'primary.main' : 'inherit'
              },
              '&:hover .workspace-resource-tab-close, &:focus-within .workspace-resource-tab-close':
                {
                  opacity: 1
                }
            }}
          >
            {tab.kind === 'mcp' && connectorIcon ? (
              connectorIcon(tab.icon)
            ) : (tab.kind === 'file' || tab.kind === 'directory' || tab.kind === 'notebook') &&
              fileIcon ? (
              fileIcon(tab)
            ) : (
              <Icon sx={{ flexShrink: 0, fontSize: 18 }} />
            )}
            <Typography
              component="span"
              noWrap
              sx={{
                flex: 1,
                minWidth: 0,
                fontSize: '0.78rem',
                fontWeight: selected ? 800 : 650,
                lineHeight: '18px'
              }}
            >
              {tab.title}
            </Typography>
            {tab.kind === 'notebook' && tab.dirty && (
              <Box
                component="span"
                role="img"
                aria-label="未保存修改"
                sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'warning.main' }}
              />
            )}
            <Box
              className="workspace-resource-tab-close"
              component="span"
              role="button"
              aria-label={`关闭 ${tab.title}`}
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                event.stopPropagation()
                onClose(tab)
              }}
              sx={{
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
              }}
            >
              <PhiIcons.action.close sx={{ fontSize: 14 }} />
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
