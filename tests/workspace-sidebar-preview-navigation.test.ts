import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import type { WorkspaceSidebarMode } from '../src/renderer/src/lib/workspaceSidebar'

// Exercise App's actual callback, including the folded-state restoration after navigation.
const source = readFileSync('src/renderer/src/App.tsx', 'utf8')
const start = source.indexOf('  const onWorkspaceSidebarPreviewNavigate = useCallback(')
assert.ok(start >= 0)
const end = source.indexOf('\n  const workspaceSidebarProps = useMemo', start)
assert.ok(end > start)
const callback = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

function navigate(
  mode: WorkspaceSidebarMode,
  sidebarOpen = false
): {
  closes: number
  clears: number
  open: boolean
  sidebarMode: WorkspaceSidebarMode
} {
  // Opening a resource may expand its sidebar before the preview callback runs.
  const result = { closes: 0, clears: 0, open: true, sidebarMode: mode }
  const invoke = runInNewContext(`${callback}\nonWorkspaceSidebarPreviewNavigate`, {
    useCallback: (action: () => void) => action,
    workspaceSidebarPreviewMode: mode,
    visibleWorkspaceSidebarPreview: { mode },
    workspaceSidebarMode: 'conversations',
    isSidebarOpen: sidebarOpen,
    closeWorkspaceSidebarPreview: () => result.closes++,
    clearWorkspaceSidebarPreviewCloseTimer: () => result.clears++,
    setIsSidebarOpen: (open: boolean) => {
      result.open = open
    },
    setWorkspaceSidebarMode: (sidebarMode: WorkspaceSidebarMode) => {
      result.sidebarMode = sidebarMode
    }
  }) as () => void
  invoke()
  return result
}

for (const mode of ['files', 'runtime', 'plugins', 'skills', 'mcp', 'wrappers'] as const) {
  test(`${mode} selection retains its hover preview and the folded sidebar`, () => {
    const result = navigate(mode)
    assert.equal(result.closes, 0)
    assert.equal(result.clears, 1)
    assert.equal(result.open, false)
    assert.equal(result.sidebarMode, mode)
  })

  test(`${mode} hover navigation preserves an already pinned different sidebar`, () => {
    const result = navigate(mode, true)
    assert.equal(result.closes, 0)
    assert.equal(result.sidebarMode, 'conversations')
    assert.equal(result.open, true)
  })
}

for (const mode of ['conversations', 'projects'] as const) {
  test(`${mode} navigation keeps its existing dismiss behavior`, () => {
    assert.equal(navigate(mode).closes, 1)
  })
}

const activitySource = readFileSync('src/renderer/src/AppActivityBar.tsx', 'utf8')
const blurStart = activitySource.indexOf('  const handleWorkspaceSidebarPreviewBlur = useCallback(')
const blurEnd = activitySource.indexOf('\n  const skipPreviewFocusRef =', blurStart)
assert.ok(blurStart >= 0 && blurEnd > blurStart)
const blurCallback = ts.transpileModule(activitySource.slice(blurStart, blurEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

function blurPreview(
  pointerInside: boolean,
  focusStaysInside = false
): {
  closes: number
  active: boolean
} {
  class PreviewNode {}
  const surface = { current: true }
  let closes = 0
  const invoke = runInNewContext(`${blurCallback}\nhandleWorkspaceSidebarPreviewBlur`, {
    useCallback: (action: unknown) => action,
    Node: PreviewNode,
    previewPointerInsideRef: { current: pointerInside },
    previewSurfaceActiveRef: surface,
    requestWorkspaceSidebarPreviewClose: () => closes++
  }) as (event: unknown) => void
  invoke({
    relatedTarget: focusStaysInside ? new PreviewNode() : null,
    currentTarget: { contains: () => focusStaysInside }
  })
  return { closes, active: surface.current }
}

test('focus transfer to an opened detail keeps a preview open while the pointer is inside', () => {
  assert.deepEqual(blurPreview(true), { closes: 0, active: true })
})

test('keyboard focus leaving a preview closes it when the pointer is outside', () => {
  assert.deepEqual(blurPreview(false), { closes: 1, active: false })
})

test('focus moving between preview controls does not close the panel', () => {
  assert.deepEqual(blurPreview(false, true), { closes: 0, active: true })
})
