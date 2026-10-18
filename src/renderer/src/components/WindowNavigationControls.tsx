import { Box, IconButton, Tooltip } from '@mui/material'
import { useUiLanguage } from '../lib/i18n'
import { windowUiCopy } from '../lib/windowUiCopy'
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
  useUiLanguage()
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
      <Tooltip
        title={isSidebarOpen ? windowUiCopy.collapseSidebar : windowUiCopy.expandSidebar}
        placement="bottom"
      >
        <IconButton
          size="small"
          aria-label={isSidebarOpen ? windowUiCopy.collapseSidebar : windowUiCopy.expandSidebar}
          data-phi-window-sidebar-toggle-icon={isSidebarOpen ? 'collapse' : 'expand'}
          onClick={onToggleSidebar}
          sx={{ ...iconButtonSx, color: isSidebarOpen ? 'text.primary' : 'text.secondary' }}
        >
          <SidebarToggleIcon size={19} />
        </IconButton>
      </Tooltip>
      <Tooltip title={windowUiCopy.searchChats}>
        <IconButton
          size="small"
          aria-label={windowUiCopy.searchChats}
          onClick={onOpenSessionSearch}
          sx={iconButtonSx}
        >
          <GoSearch size={19} />
        </IconButton>
      </Tooltip>
    </Box>
  )
}
