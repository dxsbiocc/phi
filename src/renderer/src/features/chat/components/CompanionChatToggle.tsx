import { IconButton, Tooltip } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { VscLayoutPanelDock, VscLayoutSidebarLeftDock } from 'react-icons/vsc'

export function CompanionChatToggle({
  destination,
  onToggle
}: {
  destination: 'sidebar' | 'tab'
  onToggle: () => void
}): React.JSX.Element {
  const label = destination === 'sidebar' ? '移到左侧边栏' : '放回标签区'
  const LayoutIcon = destination === 'sidebar' ? VscLayoutSidebarLeftDock : VscLayoutPanelDock

  return (
    <Tooltip title={label} enterDelay={400}>
      <IconButton
        data-phi-companion-chat-destination={destination}
        size="small"
        aria-label={label}
        onClick={onToggle}
        sx={{
          width: 32,
          height: 30,
          flexShrink: 0,
          borderRadius: 1.5,
          color: 'text.secondary',
          bgcolor: 'transparent',
          WebkitAppRegion: 'no-drag',
          '&:hover': {
            bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1),
            color: 'primary.main'
          }
        }}
      >
        <LayoutIcon aria-hidden focusable="false" size={18} />
      </IconButton>
    </Tooltip>
  )
}
