import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

function actualCallback(path: string, name: string, next: string): string {
  const source = readFileSync(path, 'utf8')
  const syntax = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let statement: ts.VariableStatement | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name
      )
    )
      statement = node
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.ok(statement, `${name} must still have an actual callback seam before ${next}`)
  return `${
    ts.transpileModule(statement.getText(syntax), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText
  }\n${name}`
}

const requestCode = actualCallback(
  'src/renderer/src/AppActivityBar.tsx',
  'requestWorkspaceSidebarPreviewClose',
  'handleWorkspaceSidebarPreviewInteractionChange'
)

for (const [label, active, locked] of [
  ['pointer or focus remains in the panel', true, false],
  ['an embedded dialog is active', false, true]
] as const) {
  test(`an anchor blur clears the close timer while ${label}`, () => {
    let clears = 0
    let schedules = 0
    const invoke = runInNewContext(requestCode, {
      useCallback: (action: () => void) => action,
      previewInteractionLockedRef: { current: locked },
      previewSurfaceActiveRef: { current: active },
      isPointerWithinWorkspaceSidebarPreview: () => false,
      clearWorkspaceSidebarPreviewCloseTimer: () => clears++,
      scheduleWorkspaceSidebarPreviewClose: () => schedules++
    }) as () => void
    invoke()
    assert.equal(clears, 1)
    assert.equal(schedules, 0)
  })
}

const closeCode = actualCallback(
  'src/renderer/src/App.tsx',
  'closeWorkspaceSidebarPreview',
  'openWorkspaceSidebarPreview'
)

const enterCode = actualCallback(
  'src/renderer/src/AppActivityBar.tsx',
  'handleWorkspaceSidebarPreviewEnter',
  'handleWorkspaceSidebarPreviewFocus'
)

for (const inside of [true, false]) {
  test(`enter events follow region containment even when a portal reports inside=${inside}`, () => {
    const pointer = { current: false }
    const surface = { current: false }
    let clears = 0
    let opens = 0
    const invoke = runInNewContext(enterCode, {
      useCallback: (action: unknown) => action,
      previewPointerInsideRef: pointer,
      previewSurfaceActiveRef: surface,
      isPointerWithinWorkspaceSidebarPreview: () => inside,
      clearWorkspaceSidebarPreviewCloseTimer: () => clears++,
      isWorkspaceSidebarPreviewOpen: false,
      displayedPreview: { mode: 'mcp', anchorEl: {} },
      openWorkspaceSidebarPreview: () => opens++
    }) as () => void
    invoke()
    assert.equal(pointer.current, inside)
    assert.equal(surface.current, inside)
    assert.equal(clears, inside ? 1 : 0)
    assert.equal(opens, inside ? 1 : 0)
  })
}

function pendingClose(): {
  pointer: { panel: boolean; anchor: boolean; geometry: boolean }
  close: (delay?: number, expectedPreview?: object) => void
  deliver: () => void
  count: () => number
  setPreview: (preview: object) => void
} {
  const pointer = { panel: false, anchor: false, geometry: false }
  let closes = 0
  let preview: object | null = {}
  let timerPending = false
  let deliver = (): void => {
    throw new Error('No timer scheduled')
  }
  const close = runInNewContext(closeCode, {
    useCallback: (action: unknown) => action,
    isPointerWithinWorkspaceSidebarPreview: () =>
      pointer.geometry || pointer.panel || pointer.anchor,
    isWorkspaceSidebarPreviewDialogActive: () => false,
    clearWorkspaceSidebarPreviewCloseTimer: () => {
      timerPending = false
    },
    workspaceSidebarPreviewCloseTimer: { current: null },
    setWorkspaceSidebarPreview: (
      next: object | null | ((current: object | null) => object | null)
    ) => {
      preview = typeof next === 'function' ? next(preview) : next
      if (preview === null) closes++
    },
    window: {
      setTimeout: (action: () => void) => {
        deliver = action
        timerPending = true
        return 1
      }
    },
    document: {
      getElementById: () => ({ matches: () => pointer.panel }),
      querySelector: (selector: string) =>
        selector.includes('app-activity-bar') ? { matches: () => pointer.anchor } : null
    }
  }) as (delay?: number, expectedPreview?: object) => void
  return {
    pointer,
    close,
    deliver: () => {
      if (!timerPending) return
      timerPending = false
      deliver()
    },
    count: () => closes,
    setPreview: (value) => {
      preview = value
    }
  }
}

for (const target of ['panel', 'anchor'] as const) {
  test(`a queued close rechecks the ${target} hover at delivery time`, () => {
    const state = pendingClose()
    state.close(350)
    state.pointer[target] = true
    state.deliver()
    assert.equal(state.count(), 0)
  })
}

test('a queued close completes after the pointer leaves both surfaces', () => {
  const state = pendingClose()
  state.close(350)
  state.deliver()
  assert.equal(state.count(), 1)
})

test('a title tooltip cannot close a preview while the pointer remains within its bounds', () => {
  const state = pendingClose()
  state.pointer.geometry = true
  state.close(350)
  state.deliver()
  assert.equal(state.count(), 0)
})

test('explicit close still works while the panel is hovered', () => {
  const state = pendingClose()
  state.pointer.panel = true
  state.close()
  assert.equal(state.count(), 1)
})

test('completion of an older navigation cannot close a newly opened preview', () => {
  const state = pendingClose()
  const original = { mode: 'conversations' }
  state.setPreview({ mode: 'mcp' })
  state.close(0, original)
  assert.equal(state.count(), 0)
})

test('navigation completion can still dismiss its own preview', () => {
  const state = pendingClose()
  const original = { mode: 'conversations' }
  state.setPreview(original)
  state.close(0, original)
  assert.equal(state.count(), 1)
})

test('an old navigation completion preserves the newer preview close timer', () => {
  const state = pendingClose()
  state.setPreview({ mode: 'mcp' })
  state.close(350)
  state.close(0, { mode: 'conversations' })
  state.deliver()
  assert.equal(state.count(), 1)
})
