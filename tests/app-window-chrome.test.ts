import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { AppWindowChrome } from '../src/renderer/src/components/app-shell/AppWindowChrome'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import type { WindowChromeLayout } from '../src/renderer/src/lib/windowChromeLayout'

test.beforeEach(() => setUiLanguage('zh-CN'))
test.afterEach(() => setUiLanguage('en'))

const theme = createTheme()

const windowedLayout: WindowChromeLayout = {
  showMacWindowControls: true,
  topLeftChromeInset: 14,
  topLeftChromeGap: 18,
  titlebarLeadingReserve: 162,
  mainColumnTitlebarInset: 0
}

const fullscreenLayout: WindowChromeLayout = {
  ...windowedLayout,
  showMacWindowControls: false,
  topLeftChromeGap: 0
}

function renderChrome(
  options: {
    isMac?: boolean
    chromeLayout?: WindowChromeLayout
    isSidebarOpen?: boolean
    activePanels?: ('jobs' | 'terminal' | 'browser')[]
    sidePanelWidth?: number
    sidePanelOverlay?: boolean
  } = {}
): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(AppWindowChrome, {
        isMac: options.isMac ?? true,
        chromeLayout: options.chromeLayout ?? windowedLayout,
        isSidebarOpen: options.isSidebarOpen ?? false,
        onToggleSidebar: () => undefined,
        onOpenSessionSearch: () => undefined,
        onCloseWindow: () => undefined,
        onMinimizeWindow: () => undefined,
        onToggleFullscreen: () => undefined,
        activePanels: options.activePanels ?? [],
        sidePanelWidth: options.sidePanelWidth ?? 340,
        sidePanelOverlay: options.sidePanelOverlay ?? false,
        onRefreshSidePanel: () => undefined,
        onTogglePanel: () => undefined
      })
    )
  )
}

test('windowed mac chrome keeps traffic lights and navigation in one hit region', () => {
  const markup = renderChrome()

  assert.match(markup, /data-phi-window-top-left-chrome="true"/)
  assert.match(markup, /data-phi-mac-window-controls="true"/)
  assert.match(markup, /data-phi-window-navigation-controls="true"/)
  assert.match(markup, /left:14px/)
  assert.match(markup, /gap:18px/)
  // Both groups are rendered inside the one positioned cluster.
  const cluster = markup.indexOf('data-phi-window-top-left-chrome')
  const trafficLights = markup.indexOf('data-phi-mac-window-controls')
  const navigation = markup.indexOf('data-phi-window-navigation-controls')
  assert.ok(cluster >= 0 && trafficLights > cluster && navigation > trafficLights)
})

test('fullscreen mac chrome drops the traffic lights but keeps navigation', () => {
  const markup = renderChrome({ chromeLayout: fullscreenLayout })

  assert.match(markup, /data-phi-window-top-left-chrome="true"/)
  assert.doesNotMatch(markup, /data-phi-mac-window-controls="true"/)
  assert.match(markup, /data-phi-window-navigation-controls="true"/)
})

test('non-mac chrome renders only the workspace toggles', () => {
  const markup = renderChrome({
    isMac: false,
    chromeLayout: { ...windowedLayout, showMacWindowControls: false }
  })

  assert.doesNotMatch(markup, /data-phi-window-top-left-chrome/)
  assert.match(markup, /data-phi-workspace-top-right-chrome="true"/)
  assert.match(markup, /data-phi-top-right-controls="workspace"/)
})

test('the top-right toggles clear the panel width only while it is docked', () => {
  assert.match(renderChrome(), /right:14px/)

  const docked = renderChrome({
    activePanels: ['jobs'],
    sidePanelWidth: 340,
    sidePanelOverlay: false
  })
  assert.match(docked, /right:calc\(340px \+ 1px \+ 14px\)/)

  const floating = renderChrome({
    activePanels: ['jobs'],
    sidePanelWidth: 340,
    sidePanelOverlay: true
  })
  assert.match(floating, /right:calc\(340px \+ 0px \+ 14px\)/)
})
