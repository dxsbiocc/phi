import { Box, IconButton, Tooltip } from '@mui/material'
import { GoSearch, GoSidebarCollapse, GoSidebarExpand } from 'react-icons/go'

/**
 * Sits to the right of the macOS traffic lights (MacWindowControls): a
 * sidebar toggle and session search.
 *
 * Like MacWindowControls, this does NOT position itself or declare its own
 * `-webkit-app-region` boundary -- App.tsx wraps both inside one shared
 * absolutely-positioned, no-drag container. See MacWindowControls' own
 * comment for why two separate sibling no-drag regions is worth avoiding.
 */
export default function WindowNavigationControls({
  isSidebarOpen,
  onToggleSidebar,
  onOpenSessionSearch
}: {
  isSidebarOpen: boolean
  onToggleSidebar: () => void
  onOpenSessionSearch: () => void
}): React.JSX.Element {
  const iconButtonSx = {
    width: 28,
    height: 28,
    color: 'text.secondary',
    '&.Mui-disabled': {
      color: 'text.disabled'
    }
  }
  const SidebarToggleIcon = isSidebarOpen ? GoSidebarCollapse : GoSidebarExpand

  return (
    <Box
      data-phi-window-navigation-controls="true"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.25,
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Tooltip title={isSidebarOpen ? '收起侧边栏' : '展开侧边栏'} placement="bottom">
        <IconButton
          size="small"
          aria-label={isSidebarOpen ? '收起侧边栏' : '展开侧边栏'}
          data-phi-window-sidebar-toggle-icon={isSidebarOpen ? 'collapse' : 'expand'}
          onClick={onToggleSidebar}
          sx={{ ...iconButtonSx, color: isSidebarOpen ? 'text.primary' : 'text.secondary' }}
        >
          <SidebarToggleIcon size={19} />
        </IconButton>
      </Tooltip>
      <Tooltip title="查找会话">
        <IconButton
          size="small"
          aria-label="查找会话"
          onClick={onOpenSessionSearch}
          sx={iconButtonSx}
        >
          <GoSearch size={19} />
        </IconButton>
      </Tooltip>
    </Box>
  )
}
