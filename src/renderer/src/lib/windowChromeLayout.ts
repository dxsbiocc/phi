export const WINDOW_TITLEBAR_HEIGHT = 44

const activityBarWidth = 48
const macChromeHorizontalInset = 14
const macWindowedChromeGap = 18
// Mirrors MacWindowControls so removing the whole group in fullscreen also
// removes exactly its occupied width from the titlebar reserve.
const macWindowControlDiameter = 14
const macWindowControlCount = 3
const macWindowControlGap = 8
const macWindowedTitlebarLeadingReserve = 162
const macWindowControlsWidth =
  macWindowControlDiameter * macWindowControlCount +
  macWindowControlGap * (macWindowControlCount - 1)
const macFullscreenTitlebarLeadingReserve =
  macWindowedTitlebarLeadingReserve - macWindowControlsWidth - macWindowedChromeGap

export type WindowChromeLayoutInput = {
  isMac: boolean
  sidebarOpen: boolean
  fullscreen: boolean
}

export type WindowChromeLayout = {
  showMacWindowControls: boolean
  topLeftChromeInset: number
  topLeftChromeGap: number
  titlebarLeadingReserve: number
  mainColumnTitlebarInset: number
}

export function windowChromeLayout({
  isMac,
  sidebarOpen,
  fullscreen
}: WindowChromeLayoutInput): WindowChromeLayout {
  if (!isMac) {
    return {
      showMacWindowControls: false,
      topLeftChromeInset: 0,
      topLeftChromeGap: 0,
      titlebarLeadingReserve: 0,
      mainColumnTitlebarInset: 0
    }
  }

  const titlebarLeadingReserve = fullscreen
    ? macFullscreenTitlebarLeadingReserve
    : macWindowedTitlebarLeadingReserve

  return {
    showMacWindowControls: !fullscreen,
    topLeftChromeInset: macChromeHorizontalInset,
    topLeftChromeGap: fullscreen ? 0 : macWindowedChromeGap,
    titlebarLeadingReserve,
    mainColumnTitlebarInset: sidebarOpen ? 0 : titlebarLeadingReserve - activityBarWidth
  }
}
