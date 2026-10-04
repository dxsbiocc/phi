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

test('App.tsx wraps both window-control clusters in exactly one shared no-drag boundary', () => {
  const appSource = readSource('src/renderer/src/App.tsx')

  const clusterMatch = appSource.match(
    /\{isMac && \([\s\S]*?data-phi-window-top-left-chrome="true"[\s\S]*?<MacWindowControls[\s\S]*?<WindowNavigationControls[\s\S]*?\)\}/
  )
  assert.ok(clusterMatch, 'expected the isMac-gated window-controls JSX block')
  const cluster = clusterMatch![0]

  const noDragCount = (cluster.match(/WebkitAppRegion:\s*'no-drag'/g) ?? []).length
  assert.equal(noDragCount, 1, 'exactly one no-drag boundary should wrap the whole cluster')
  assert.match(cluster, /position:\s*'absolute'/)
  assert.match(cluster, /pointerEvents:\s*'auto'/)
  assert.match(cluster, /zIndex:\s*30/)
})

test('App.tsx renders top-left chrome after draggable workspace layers', () => {
  const appSource = readSource('src/renderer/src/App.tsx')

  const topLeftChromeIndex = appSource.indexOf('data-phi-window-top-left-chrome="true"')
  const activityBarIndex = appSource.indexOf('<AppActivityBar')
  const workspaceSidebarIndex = appSource.indexOf('<AppWorkspaceSidebar')
  const workspaceFileHeaderIndex = appSource.indexOf('<WorkspaceFileHeader')
  const workspaceSidePanelIndex = appSource.indexOf('data-phi-workspace-side-panel-shell="true"')

  assert.ok(topLeftChromeIndex >= 0, 'expected a top-left chrome marker')
  assert.ok(
    topLeftChromeIndex > activityBarIndex,
    'top-left controls must render after the activity bar to preserve hit testing'
  )
  assert.ok(
    topLeftChromeIndex > workspaceSidebarIndex,
    'top-left controls must render after the workspace sidebar to preserve hit testing'
  )
  assert.ok(
    topLeftChromeIndex > workspaceFileHeaderIndex,
    'top-left controls must render after file headers so file-open drag regions cannot swallow clicks'
  )
  assert.ok(
    topLeftChromeIndex > workspaceSidePanelIndex,
    'top-left controls must render after the side panel shell so fullscreen panels cannot cover them'
  )
})

test('App.tsx removes macOS traffic lights in true fullscreen but keeps navigation controls', () => {
  const appSource = readSource('src/renderer/src/App.tsx')

  assert.match(appSource, /const isWindowFullscreen = useWindowFullscreen\(rendererApi, isMac\)/)
  assert.match(appSource, /fullscreen: isWindowFullscreen/)
  assert.match(
    appSource,
    /chromeLayout\.showMacWindowControls \? \([\s\S]{0,220}<MacWindowControls[\s\S]{0,500}: null\}[\s\S]{0,160}<WindowNavigationControls/
  )
  assert.match(appSource, /gap: `\$\{chromeLayout\.topLeftChromeGap\}px`/)
})
