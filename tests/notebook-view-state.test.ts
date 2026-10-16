import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import {
  notebookViewStateKey,
  rememberNotebookViewState,
  notebookViewAnchor,
  notebookViewScrollTop,
  type NotebookViewState,
  type NotebookViewStateStore
} from '../src/renderer/src/features/analysis/lib/notebookViewState'
import * as viewStateLibrary from '../src/renderer/src/features/analysis/lib/notebookViewState'

const cells = Array.from({ length: 64 }, (_, index) => ({ id: `cell-${index}` }))
const rowHeights = Object.fromEntries(cells.map((cell, index) => [cell.id, 100 + (index % 4) * 70]))
const snapshot = (scrollTop = 4300): NotebookViewState => ({
  scrollTop,
  viewportHeight: 600,
  rowHeights,
  anchor: notebookViewAnchor(cells, rowHeights, scrollTop)
})

test('view state isolates files and remote/project scopes and bounds the session cache', () => {
  const store: NotebookViewStateStore = new Map()
  const first = notebookViewStateKey('remote-a', '/same/notebook.ipynb')!
  const second = notebookViewStateKey('remote-b', '/same/notebook.ipynb')!
  assert.notEqual(first, second)
  assert.notEqual(first, notebookViewStateKey('remote-a', '/same/other.ipynb'))
  assert.equal(notebookViewStateKey('remote-a', null), null)
  rememberNotebookViewState(store, first, snapshot())
  rememberNotebookViewState(store, second, snapshot(1200))
  assert.equal(store.get(first)?.scrollTop, 4300)
  assert.equal(store.get(second)?.scrollTop, 1200)
  for (let index = 0; index < 51; index++) {
    rememberNotebookViewState(store, `other-${index}`, snapshot(index))
  }
  assert.equal(store.size, 50)
  assert.equal(store.has(first), false)
})

test('a stable cell anchor follows row resizing and falls back safely when its cell disappears', () => {
  const saved = snapshot()
  assert.equal(notebookViewScrollTop(saved, cells, rowHeights), 4300)
  const taller = { ...rowHeights, 'cell-0': rowHeights['cell-0'] + 200 }
  assert.equal(notebookViewScrollTop(saved, cells, taller), 4500)
  assert.equal(notebookViewScrollTop(saved, [], {}), 4300)
})

test('the actual App cache scope isolates projects and remote hosts that share a file path', () => {
  const source = ts.createSourceFile(
    'App.tsx',
    readFileSync('src/renderer/src/App.tsx', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let expression: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'notebookViewStateScope') {
      assert.ok(node.initializer && ts.isJsxExpression(node.initializer))
      expression = node.initializer.expression
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(expression)
  const scopeExpression = expression.getText(source)
  const scope = (projectId: string | null, hostAlias: string | null, cwd = '/same'): unknown =>
    runInNewContext(`(${scopeExpression})`, {
      activeProjectId: projectId,
      activeCwd: cwd,
      activeProjectLocation: hostAlias
        ? { kind: 'ssh', canonicalRoot: '/same' }
        : { kind: 'local' },
      activeProject: hostAlias ? { remoteHostAlias: hostAlias } : null
    })
  assert.notEqual(scope('project-a', 'host-a'), scope('project-b', 'host-a'))
  assert.notEqual(scope('project-a', 'host-a'), scope('project-a', 'host-b'))
  assert.notEqual(scope(null, null, '/one'), scope(null, null, '/two'))
  assert.equal(scope('project-a', 'host-a'), scope('project-a', 'host-a'))
})

function hookHarness(store: NotebookViewStateStore): {
  render: (
    path: string,
    ready?: boolean
  ) => ReturnType<
    typeof import('../src/renderer/src/features/analysis/hooks/useNotebookViewState').useNotebookViewState
  >
  viewport: {
    scrollTop: number
    clientHeight: number
    scrollHeight: number
    getBoundingClientRect: () => { top: number }
  }
  unmount: () => void
  replayEffects: () => void
} {
  const slots: unknown[] = []
  const cleanups = new Map<number, () => void>()
  const setups = new Map<number, () => void | (() => void)>()
  let cursor = 0
  let pendingEffects: Array<() => void> = []
  const viewport = {
    scrollTop: 0,
    clientHeight: 600,
    scrollHeight: 15000,
    getBoundingClientRect: () => ({ top: 0 })
  }
  const list = { getBoundingClientRect: () => ({ top: 30 - viewport.scrollTop }) }
  const hooks = {
    useRef: (initial: unknown) => {
      const slot = cursor++
      return (slots[slot] ??= { current: initial })
    },
    useState: (initial: unknown) => {
      const slot = cursor++
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
      return [
        slots[slot],
        (update: unknown) => {
          slots[slot] = typeof update === 'function' ? update(slots[slot]) : update
        }
      ]
    },
    useCallback: (callback: unknown) => {
      cursor++
      return callback
    },
    useLayoutEffect: (setup: () => void | (() => void), dependencies: unknown[]) => {
      const slot = cursor++
      const previous = slots[slot] as unknown[] | undefined
      if (previous && dependencies.every((value, index) => Object.is(value, previous[index])))
        return
      slots[slot] = dependencies
      setups.set(slot, setup)
      pendingEffects.push(() => {
        cleanups.get(slot)?.()
        const cleanup = setup()
        if (cleanup) cleanups.set(slot, cleanup)
        else cleanups.delete(slot)
      })
    }
  }
  const module = { exports: {} as Record<string, (...args: unknown[]) => unknown> }
  const code = ts.transpileModule(
    readFileSync('src/renderer/src/features/analysis/hooks/useNotebookViewState.ts', 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name: string) => (name === 'react' ? hooks : viewStateLibrary),
    Math,
    Map
  })
  const render = (
    path: string,
    ready = true
  ): ReturnType<
    typeof import('../src/renderer/src/features/analysis/hooks/useNotebookViewState').useNotebookViewState
  > => {
    cursor = 0
    pendingEffects = []
    const result = module.exports.useNotebookViewState({
      store,
      scope: 'project-a',
      path,
      ready,
      cells,
      scrollViewportRef: { current: viewport },
      virtualListRef: { current: list }
    }) as ReturnType<
      typeof import('../src/renderer/src/features/analysis/hooks/useNotebookViewState').useNotebookViewState
    >
    pendingEffects.forEach((effect) => effect())
    return result
  }
  return {
    render,
    viewport,
    unmount: () => cleanups.forEach((cleanup) => cleanup()),
    replayEffects: () => {
      cleanups.forEach((cleanup) => cleanup())
      setups.forEach((setup, slot) => {
        const cleanup = setup()
        if (cleanup) cleanups.set(slot, cleanup)
      })
    }
  }
}

test('the actual view-state hook restores A/B/A before scrolling and survives a normal-file unmount', () => {
  const store: NotebookViewStateStore = new Map()
  let harness = hookHarness(store)
  let result = harness.render('/a.ipynb')
  for (const [id, height] of Object.entries(rowHeights)) result.recordRowHeight(id, height)
  harness.viewport.scrollTop = 4330
  result.captureViewState()
  result = harness.render('/b.ipynb')
  assert.equal(harness.viewport.scrollTop, 0)
  harness.viewport.scrollTop = 1230
  result.captureViewState()
  result = harness.render('/a.ipynb')
  assert.equal(
    result.virtualViewport.scrollTop,
    4300,
    'virtual rows must be seeded before DOM restoration'
  )
  assert.equal(result.virtualRowHeights['cell-0'], 100)
  assert.equal(harness.viewport.scrollTop, 4330)
  harness.replayEffects()
  assert.equal(
    harness.viewport.scrollTop,
    4330,
    'StrictMode replay must retain the restored position'
  )
  harness.unmount()
  harness = hookHarness(store)
  result = harness.render('/a.ipynb', false)
  result.captureViewState()
  assert.equal(store.get(notebookViewStateKey('project-a', '/a.ipynb')!)?.scrollTop, 4300)
  result = harness.render('/a.ipynb')
  assert.equal(result.virtualViewport.scrollTop, 4300)
  assert.equal(harness.viewport.scrollTop, 4330)
  harness.viewport.scrollHeight = 500
  harness.render('/a.ipynb')
  harness.unmount()
  harness = hookHarness(store)
  harness.viewport.scrollHeight = 500
  harness.render('/a.ipynb')
  assert.equal(
    harness.viewport.scrollTop,
    0,
    'shrunk content must clamp inside the DOM scroll range'
  )
})
