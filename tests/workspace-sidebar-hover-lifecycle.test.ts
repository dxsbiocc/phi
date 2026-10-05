import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

function actualCallback(path: string, name: string, next: string): string {
  const source = readFileSync(path, 'utf8')
  const start = source.indexOf(`  const ${name} = useCallback(`)
  const end = source.indexOf(`\n  const ${next}`, start)
  assert.ok(start >= 0 && end > start)
  return `${
    ts.transpileModule(source.slice(start, end), {
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

function pendingClose(): {
  pointer: { panel: boolean; anchor: boolean }
  close: (delay?: number, expectedPreview?: object) => void
  deliver: () => void
  count: () => number
  setPreview: (preview: object) => void
} {
  const pointer = { panel: false, anchor: false }
  let closes = 0
  let preview: object | null = {}
  let timerPending = false
  let deliver = (): void => {
    throw new Error('No timer scheduled')
  }
  const close = runInNewContext(closeCode, {
    useCallback: (action: unknown) => action,
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
