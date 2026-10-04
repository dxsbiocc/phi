import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

test('workspace hover preview stays open while nested project actions are open', () => {
  const activityBarSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/AppActivityBar.tsx'),
    'utf8'
  )

  assert.match(activityBarSource, /previewInteractionLockedRef/)
  assert.match(activityBarSource, /previewSurfaceActiveRef/)
  assert.match(activityBarSource, /requestWorkspaceSidebarPreviewClose/)
  assert.match(
    activityBarSource,
    /onPreviewInteractionChange=\{handleWorkspaceSidebarPreviewInteractionChange\}/
  )
})

test('workspace activity buttons apply selected theme color to every icon implementation', () => {
  const activityBarSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/AppActivityBar.tsx'),
    'utf8'
  )

  assert.match(activityBarSource, /function activityBarButtonSx\(active: boolean\)/)
  assert.match(activityBarSource, /color: active \? 'primary\.main' : 'text\.secondary'/)
  assert.match(activityBarSource, /'& svg': \{\s*color: 'inherit'\s*\}/)
  assert.match(activityBarSource, /mode: 'wrappers', label: 'Wrappers', icon: NavWrappersIcon/)
  assert.match(activityBarSource, /active=\{isWorkspaceSidebarModeExpanded\(mode\)\}/)
  assert.match(
    activityBarSource,
    /prev\.isWorkspaceSidebarModeExpanded === next\.isWorkspaceSidebarModeExpanded/
  )
})
