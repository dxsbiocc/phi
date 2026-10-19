import { Box } from '@mui/material'
import type { SxProps, Theme } from '@mui/material/styles'

import { WINDOW_TITLEBAR_HEIGHT, type WindowChromeLayout } from '../../lib/windowChromeLayout'
import type { WorkspaceSidePanelMode } from '../../lib/workspaceSidePanelMode'
import MacWindowControls from '../MacWindowControls'
import WindowNavigationControls from '../WindowNavigationControls'
import { TopRightControls, titlebarChromeIconButtonSize } from './TopRightControls'

/**
 * The two absolute-positioned chrome clusters of the app window: the macOS
 * traffic-light/navigation group on the left and the workspace panel toggles on
 * the right.
 *
 * Both are overlays rather than siblings inside the layout, and they must
 * render *after* every draggable workspace layer so an Electron drag region
 * cannot swallow their clicks. Keeping them in one component makes that
 * ordering a property of the tree instead of a property of where the JSX
 * happens to sit in App.tsx.
 */

/** Shared with TopRightControls so both clusters sit on one titlebar baseline. */
const titlebarChromeTopOffset = `${(WINDOW_TITLEBAR_HEIGHT - titlebarChromeIconButtonSize) / 2}px`
const titlebarChromeHorizontalInset = '14px'

const chromeClusterSx = {
  position: 'absolute',
  top: titlebarChromeTopOffset,
  display: 'flex',
  alignItems: 'center',
  pointerEvents: 'auto',
  zIndex: 30,
  WebkitAppRegion: 'no-drag'
} as const

function topLeftChromeSx(layout: WindowChromeLayout): SxProps<Theme> {
  return {
    ...chromeClusterSx,
    left: `${layout.topLeftChromeInset}px`,
    gap: `${layout.topLeftChromeGap}px`
  }
}

function topRightChromeSx({
  sidePanelOpen,
  sidePanelWidth,
  sidePanelOverlay
}: {
  sidePanelOpen: boolean
  sidePanelWidth: number
  sidePanelOverlay: boolean
}): SxProps<Theme> {
  return {
    ...chromeClusterSx,
    right: sidePanelOpen
      ? `calc(${sidePanelWidth}px + ${sidePanelOverlay ? 0 : 1}px + ${titlebarChromeHorizontalInset})`
      : titlebarChromeHorizontalInset
  }
}

export function AppWindowChrome({
  isMac,
  chromeLayout,
  isSidebarOpen,
  onToggleSidebar,
  onOpenSessionSearch,
  onCloseWindow,
  onMinimizeWindow,
  onToggleFullscreen,
  activePanels,
  sidePanelWidth,
  sidePanelOverlay,
  onRefreshSidePanel,
  onTogglePanel
}: {
  isMac: boolean
  chromeLayout: WindowChromeLayout
  isSidebarOpen: boolean
  onToggleSidebar: () => void
  onOpenSessionSearch: () => void
  onCloseWindow: () => void
  onMinimizeWindow: () => void
  onToggleFullscreen: () => void
  activePanels: readonly WorkspaceSidePanelMode[]
  /** Rendered width of the docked/floating side panel. */
  sidePanelWidth: number
  /** When the panel floats, it no longer pushes the toggles inward. */
  sidePanelOverlay: boolean
  onRefreshSidePanel: () => void
  onTogglePanel: (mode: WorkspaceSidePanelMode) => void
}): React.JSX.Element {
  const sidePanelOpen = activePanels.length > 0
  return (
    <>
      {isMac && (
        <Box data-phi-window-top-left-chrome="true" sx={topLeftChromeSx(chromeLayout)}>
          {chromeLayout.showMacWindowControls ? (
            <MacWindowControls
              onClose={onCloseWindow}
              onMinimize={onMinimizeWindow}
              onToggleFullscreen={onToggleFullscreen}
            />
          ) : null}
          <WindowNavigationControls
            isSidebarOpen={isSidebarOpen}
            onToggleSidebar={onToggleSidebar}
            onOpenSessionSearch={onOpenSessionSearch}
          />
        </Box>
      )}
      <Box
        data-phi-workspace-top-right-chrome="true"
        sx={topRightChromeSx({ sidePanelOpen, sidePanelWidth, sidePanelOverlay })}
      >
        {/* The app-level chrome never offers a tree refresh; only the notebook
            titlebar does, which is why the refresh slot stays off here. */}
        <TopRightControls
          showSidePanelRefresh={false}
          sidePanelRefreshDisabled={false}
          showSidePanelButtons
          activePanels={activePanels}
          onRefreshSidePanel={onRefreshSidePanel}
          onTogglePanel={onTogglePanel}
        />
      </Box>
    </>
  )
}
