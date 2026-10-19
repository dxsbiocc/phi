import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

test('MacWindowControls and WindowNavigationControls do not declare their own position/app-region', () => {
  // They used to each be an independent absolutely-positioned, no-drag
  // sibling. Two separate no-drag rectangles side by side is the shape of
  // a known Electron frameless-window quirk: a later layout pass can drop
  // one region's no-drag carve-out, leaving that whole group unclickable
  // (which is what "these buttons only work once" reported) while the
  // drag region underneath swallows further clicks. App.tsx now wraps both
  // in one shared no-drag container instead.
  const macControls = readSource('src/renderer/src/components/MacWindowControls.tsx')
  const navControls = readSource('src/renderer/src/components/WindowNavigationControls.tsx')

  for (const source of [macControls, navControls]) {
    assert.doesNotMatch(source, /position:\s*'absolute'/)
    assert.doesNotMatch(source, /WebkitAppRegion:\s*'no-drag'.*\n.*zIndex/)
  }
})

test('the window chrome wraps both clusters in exactly one shared no-drag boundary', () => {
  const chromeSource = readSource('src/renderer/src/components/app-shell/AppWindowChrome.tsx')

  const clusterMatch = chromeSource.match(
    /\{isMac && \([\s\S]*?data-phi-window-top-left-chrome="true"[\s\S]*?<MacWindowControls[\s\S]*?<WindowNavigationControls[\s\S]*?\)\}/
  )
  assert.ok(clusterMatch, 'expected the isMac-gated window-controls JSX block')

  // One shared style object is the single no-drag boundary; both clusters spread it.
  const noDragCount = (chromeSource.match(/WebkitAppRegion:\s*'no-drag'/g) ?? []).length
  assert.equal(noDragCount, 1, 'exactly one no-drag boundary should exist for both clusters')
  assert.match(chromeSource, /const chromeClusterSx = \{[\s\S]*?WebkitAppRegion: 'no-drag'/)
  assert.equal(
    (chromeSource.match(/\.\.\.chromeClusterSx/g) ?? []).length,
    2,
    'both the left and right cluster styles must reuse the shared boundary'
  )
  assert.match(chromeSource, /position:\s*'absolute'/)
  assert.match(chromeSource, /pointerEvents:\s*'auto'/)
  assert.match(chromeSource, /zIndex:\s*30/)
})

test('App.tsx renders the window chrome after draggable workspace layers', () => {
  const appSource = readSource('src/renderer/src/App.tsx')

  const chromeIndex = appSource.indexOf('<AppWindowChrome')
  const activityBarIndex = appSource.indexOf('<AppActivityBar')
  const workspaceSidebarIndex = appSource.indexOf('<AppWorkspaceSidebar')
  const workspaceFileHeaderIndex = appSource.indexOf('<WorkspaceFileHeader')
  const workspaceSidePanelIndex = appSource.indexOf('data-phi-workspace-side-panel-shell="true"')

  assert.ok(chromeIndex >= 0, 'expected the chrome block to be rendered')
  assert.ok(
    chromeIndex > activityBarIndex,
    'the chrome must render after the activity bar to preserve hit testing'
  )
  assert.ok(
    chromeIndex > workspaceSidebarIndex,
    'the chrome must render after the workspace sidebar to preserve hit testing'
  )
  assert.ok(
    chromeIndex > workspaceFileHeaderIndex,
    'the chrome must render after file headers so file-open drag regions cannot swallow clicks'
  )
  assert.ok(
    chromeIndex > workspaceSidePanelIndex,
    'the chrome must render after the side panel shell so fullscreen panels cannot cover it'
  )
})

test('App.tsx removes macOS traffic lights in true fullscreen but keeps navigation controls', () => {
  const appSource = readSource('src/renderer/src/App.tsx')
  const chromeSource = readSource('src/renderer/src/components/app-shell/AppWindowChrome.tsx')

  assert.match(appSource, /const isWindowFullscreen = useWindowFullscreen\(rendererApi, isMac\)/)
  assert.match(appSource, /fullscreen: isWindowFullscreen/)
  assert.match(
    chromeSource,
    /chromeLayout\.showMacWindowControls \? \([\s\S]{0,220}<MacWindowControls[\s\S]{0,500}: null\}[\s\S]{0,160}<WindowNavigationControls/
  )
  assert.match(chromeSource, /gap: `\$\{layout\.topLeftChromeGap\}px`/)
})
