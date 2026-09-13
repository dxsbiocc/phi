import { Box, IconButton, Tooltip } from '@mui/material'
import { TbChevronLeft, TbChevronRight, TbLayoutSidebar } from 'react-icons/tb'

/**
 * Sits to the right of the macOS traffic lights (MacWindowControls): a
 * sidebar collapse/expand toggle plus browser-style back/forward buttons
 * over the app's own navigation history (see navigationHistory in App.tsx).
 *
 * Like MacWindowControls, this does NOT position itself or declare its own
 * `-webkit-app-region` boundary -- App.tsx wraps both inside one shared
 * absolutely-positioned, no-drag container. See MacWindowControls' own
 * comment for why two separate sibling no-drag regions is worth avoiding.
 */
export default function WindowNavigationControls({
  isSidebarOpen,
  onToggleSidebar,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward
}: {
  isSidebarOpen: boolean
  onToggleSidebar: () => void
  canGoBack: boolean
  canGoForward: boolean
  onGoBack: () => void
  onGoForward: () => void
}): React.JSX.Element {
  const iconButtonSx = {
    width: 28,
    height: 28,
    color: 'text.secondary',
    '&.Mui-disabled': {
      color: 'text.disabled'
    }
  }

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
          onClick={onToggleSidebar}
          sx={{ ...iconButtonSx, color: isSidebarOpen ? 'text.primary' : 'text.secondary' }}
        >
          <TbLayoutSidebar size={19} />
        </IconButton>
      </Tooltip>
      <Tooltip title="后退">
        <span>
          <IconButton
            size="small"
            aria-label="后退"
            disabled={!canGoBack}
            onClick={onGoBack}
            sx={iconButtonSx}
          >
            <TbChevronLeft size={20} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="前进">
        <span>
          <IconButton
            size="small"
            aria-label="前进"
            disabled={!canGoForward}
            onClick={onGoForward}
            sx={iconButtonSx}
          >
            <TbChevronRight size={20} />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  )
}
