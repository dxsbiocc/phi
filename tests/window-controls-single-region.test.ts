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
    /\{isMac && \([\s\S]*?<MacWindowControls[\s\S]*?<WindowNavigationControls[\s\S]*?\)\}/
  )
  assert.ok(clusterMatch, 'expected the isMac-gated window-controls JSX block')
  const cluster = clusterMatch![0]

  const noDragCount = (cluster.match(/WebkitAppRegion:\s*'no-drag'/g) ?? []).length
  assert.equal(noDragCount, 1, 'exactly one no-drag boundary should wrap the whole cluster')
  assert.match(cluster, /position:\s*'absolute'/)
})
