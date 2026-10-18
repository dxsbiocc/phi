import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { createElement, type ReactElement, type ReactNode } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import ts from 'typescript'
import { getUiLanguage, setUiLanguage } from '../src/renderer/src/lib/i18n'
import {
  workspaceSidebarModeIsExpanded,
  type WorkspaceSidebarMode
} from '../src/renderer/src/lib/workspaceSidebar'

setUiLanguage('zh-CN')

type Panel = ReactElement<{
  'data-phi-retained-sidebar'?: WorkspaceSidebarMode
  sx?: { display: string }
  children?: ReactNode
}>

function sidebarHarness(): (
  mode: WorkspaceSidebarMode,
  open?: boolean,
  scopeKey?: string
) => Panel {
  const path = 'src/renderer/src/components/RetainedCatalogSidebars.tsx'
  const source = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  let retained: unknown
  const exports: Record<string, unknown> = {}
  runInNewContext(source, {
    exports,
    require: (module: string) => {
      if (module === 'react/jsx-runtime') return jsxRuntime
      if (module === '@mui/material') return { Box: 'div' }
      if (module === 'react') {
        return {
          useState: (initial: unknown) => {
            retained ??= initial
            return [retained, (next: unknown) => (retained = next)]
          }
        }
      }
      throw new Error(`Unexpected import: ${module}`)
    }
  })
  const render = exports.RetainedCatalogSidebars as (props: {
    mode: WorkspaceSidebarMode
    open: boolean
    scopeKey: string
    renderPanel: (mode: WorkspaceSidebarMode, visible: boolean) => ReactNode
  }) => Panel
  return (mode, open = true, scopeKey = '/project-a') =>
    render({
      mode,
      open,
      scopeKey,
      renderPanel: (mode, visible) => createElement('section', { id: mode, 'data-active': visible })
    })
}

function retainedPanels(tree: Panel): Panel[] {
  return (tree.props.children as [Panel[], ReactNode])[0]
}

test('closing and revisiting catalogs keeps their mounted panel keys and state slots', () => {
  const render = sidebarHarness()
  const initial = retainedPanels(render('skills'))[0]
  const hidden = retainedPanels(render('skills', false))[0]
  assert.equal(hidden.key, initial.key)
  assert.equal(hidden.props.sx?.display, 'none')
  assert.equal(
    (hidden.props.children as ReactElement<{ 'data-active': boolean }>).props['data-active'],
    false
  )

  const switched = retainedPanels(render('plugins'))
  assert.equal(switched.length, 2)
  assert.equal(switched[0].key, initial.key)
  assert.equal(switched[0].props.sx?.display, 'none')
  assert.equal(switched[1].props.sx?.display, 'flex')

  const restored = retainedPanels(render('skills'))
  assert.equal(restored[0].key, initial.key)
  assert.equal(restored[0].props.sx?.display, 'flex')
  assert.equal(restored[1].props.sx?.display, 'none')
})

test('workspace changes discard previous catalog panels instead of carrying project browsing state', () => {
  const render = sidebarHarness()
  const original = retainedPanels(render('skills'))[0]
  render('plugins')
  const next = retainedPanels(render('skills', true, '/project-b'))
  assert.equal(next.length, 1)
  assert.notEqual(next[0].key, original.key)
  assert.equal(next[0].props['data-phi-retained-sidebar'], 'skills')
  assert.equal(retainedPanels(render('skills', false, '/project-c')).length, 0)
})

test('unvisited catalogs and filesystem or session controllers are not retained', () => {
  const render = sidebarHarness()
  assert.equal(retainedPanels(render('skills', false)).length, 0)
  render('skills')
  for (const mode of ['files', 'runtime', 'conversations', 'projects'] as const) {
    const tree = render(mode)
    assert.equal(retainedPanels(tree).length, 1)
    assert.equal(retainedPanels(tree)[0].props.sx?.display, 'none')
    const active = (tree.props.children as [Panel[], Panel])[1]
    assert.equal((active.props as { id?: string }).id, mode)
  }
})

function activityClick(mode: WorkspaceSidebarMode): { selected: string[]; refreshes: number } {
  const path = 'src/renderer/src/AppActivityBar.tsx'
  const syntax = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  let click: ts.ArrowFunction | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(syntax) === 'WorkspaceSidebarNavButton'
    ) {
      const attribute = node.attributes.properties.find(
        (property) => ts.isJsxAttribute(property) && property.name.getText(syntax) === 'onClick'
      )
      if (
        attribute &&
        ts.isJsxAttribute(attribute) &&
        attribute.initializer &&
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression &&
        ts.isArrowFunction(attribute.initializer.expression)
      )
        click = attribute.initializer.expression
    }
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.ok(click)
  const code = ts.transpileModule(`const click = ${click.getText(syntax)}; click(event);`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const selected: string[] = []
  const anchor = {}
  let refreshes = 0
  runInNewContext(code, {
    mode,
    event: { currentTarget: anchor },
    closeWorkspaceSidebarPreview: () => undefined,
    onSelectWorkspaceView: (view: string, anchorEl: unknown) => {
      assert.equal(anchorEl, anchor)
      selected.push(view)
    },
    onSelectWorkspaceSidebarMode: (sidebar: string) => selected.push(sidebar),
    refreshForMode: () => async () => refreshes++
  })
  return { selected, refreshes }
}

for (const [mode, view] of [
  ['conversations', 'chat'],
  ['projects', 'projects']
] as const) {
  test(`${mode} activity navigation passes its button as the preview anchor`, () => {
    assert.deepEqual(activityClick(mode), { selected: [view], refreshes: 0 })
  })
}

for (const mode of ['runtime', 'plugins', 'skills', 'mcp', 'wrappers'] as const) {
  test(`${mode} activity navigation does not issue a second data refresh`, () => {
    assert.deepEqual(activityClick(mode), { selected: [mode], refreshes: 0 })
  })
}

function activityButton(): (props: Record<string, unknown>) => ReactElement<{
  title: string
  disableHoverListener: boolean
  disableFocusListener: boolean
  disableTouchListener: boolean
  children: Panel
}> {
  const path = 'src/renderer/src/AppActivityBar.tsx'
  const syntax = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = syntax.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'WorkspaceSidebarNavButton'
  )
  assert.ok(declaration)
  const code = ts.transpileModule(`${declaration.getText(syntax)}\nWorkspaceSidebarNavButton`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX
    }
  }).outputText
  const render = runInNewContext(code, {
    exports: {},
    require: (module: string) => {
      assert.equal(module, 'react/jsx-runtime')
      return jsxRuntime
    },
    useUiLanguage: getUiLanguage,
    IconButton: 'button',
    Tooltip: 'tooltip',
    activityBarButtonSx: () => ({})
  }) as ReturnType<typeof activityButton>
  return render
}

test('content preview and selected navigation keep the same wrapper and button slot', () => {
  const render = activityButton()
  const props = {
    mode: 'skills',
    label: '技能',
    icon: 'span',
    active: false,
    onPreviewOpen: () => undefined,
    onPreviewClose: () => undefined,
    onClick: () => undefined,
    previewOpen: true,
    onFocusPreview: () => undefined
  }
  const preview = render({ ...props, useContentPreview: true })
  const selected = render({ ...props, active: true, previewOpen: false, useContentPreview: false })
  assert.equal(preview.type, selected.type, 'wrapper replacement would disconnect the exit anchor')
  assert.equal((preview.props.children as Panel).type, (selected.props.children as Panel).type)
  assert.equal((preview.props.children as Panel).key, (selected.props.children as Panel).key)
})

test('an expanded navigation panel does not show a redundant label tooltip', () => {
  const selected = activityButton()({ active: true, useContentPreview: false, label: '技能' })
  assert.equal(selected.props.title, '')
  assert.equal(selected.props.disableHoverListener, true)
  assert.equal(selected.props.disableFocusListener, true)
  assert.equal(selected.props.disableTouchListener, true)
})

test('inactive navigation without a content preview still describes its action', () => {
  const inactive = activityButton()({ active: false, useContentPreview: false, label: '技能' })
  assert.equal(inactive.props.title, '技能')
  assert.equal(inactive.props.disableHoverListener, false)
})

test('docked conversation content does not select or suppress the conversation-list entry', () => {
  const active = workspaceSidebarModeIsExpanded({
    activeView: 'analysis',
    isSidebarOpen: true,
    workspaceSidebarMode: 'conversations',
    mode: 'conversations'
  })
  assert.equal(active, false)
  const opened: string[] = []
  let focused = 0
  let prevented = 0
  const button = activityButton()({
    mode: 'conversations',
    label: '对话',
    active,
    useContentPreview: !active,
    onPreviewOpen: (mode: string) => opened.push(mode),
    onFocusPreview: () => focused++
  }).props.children as ReactElement<{
    onMouseEnter: (event: unknown) => void
    onFocus: (event: unknown) => void
    onKeyDown: (event: unknown) => void
  }>
  button.props.onMouseEnter({ currentTarget: {} })
  button.props.onFocus({ currentTarget: {} })
  button.props.onKeyDown({
    key: 'ArrowRight',
    currentTarget: {},
    preventDefault: () => prevented++
  })
  assert.deepEqual(opened, ['conversations', 'conversations', 'conversations'])
  assert.equal(focused, 1)
  assert.equal(prevented, 1)
})

for (const [activeView, workspaceSidebarMode, view, dockedPreview] of [
  ['analysis', 'conversations', 'chat', true],
  ['analysis', 'conversations', 'projects', false],
  ['chat', 'conversations', 'chat', false],
  ['analysis', 'files', 'chat', false]
] as const) {
  test(`${view} navigation from ${activeView}/${workspaceSidebarMode} uses the correct destination`, () => {
    const path = 'src/renderer/src/App.tsx'
    const syntax = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    let callback: ts.Expression | undefined
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(syntax) === 'onSelectWorkspaceView' &&
        node.initializer &&
        ts.isCallExpression(node.initializer)
      )
        callback = node.initializer.arguments[0]
      ts.forEachChild(node, visit)
    }
    visit(syntax)
    assert.ok(callback)
    const anchor = {}
    const previews: unknown[] = []
    const selected: string[] = []
    const code = ts.transpileModule(`(${callback.getText(syntax)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText
    const select = runInNewContext(code, {
      activeView,
      workspaceSidebarMode,
      openWorkspaceSidebarPreview: (mode: string, anchorEl: unknown) =>
        previews.push([mode, anchorEl]),
      onSelectWorkspaceSidebarMode: (mode: string) => selected.push(mode)
    }) as (view: string, anchorEl: unknown) => void
    select(view, anchor)
    assert.deepEqual(previews, dockedPreview ? [['conversations', anchor]] : [])
    assert.deepEqual(
      selected,
      dockedPreview ? [] : [view === 'chat' ? 'conversations' : 'projects']
    )
  })
}
