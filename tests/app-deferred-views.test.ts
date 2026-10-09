import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement, Suspense, type ComponentType, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const appSource = readFileSync(resolve('src/renderer/src/App.tsx'), 'utf8')
const require = createRequire(import.meta.url)
const viewModules = {
  ChatView: './features/chat/ChatView',
  AnalysisView: './features/analysis/AnalysisView'
} as const
type ViewName = keyof typeof viewModules

function viewFallbacks(): Partial<Record<ViewName, string>> {
  const source = ts.createSourceFile(
    'App.tsx',
    appSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const fallbacks: Partial<Record<ViewName, string>> = {}
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'Suspense') {
      const view = node.children.find(
        (child) => ts.isJsxSelfClosingElement(child) && child.tagName.getText(source) in viewModules
      )
      const attribute = node.openingElement.attributes.properties.find(
        (property) => ts.isJsxAttribute(property) && property.name.getText(source) === 'fallback'
      )
      if (
        view &&
        ts.isJsxSelfClosingElement(view) &&
        attribute &&
        ts.isJsxAttribute(attribute) &&
        attribute.initializer &&
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression
      ) {
        fallbacks[view.tagName.getText(source) as ViewName] =
          attribute.initializer.expression.getText(source)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return fallbacks
}

function loadAppModule(): {
  views: Record<ViewName, ComponentType<{ marker: string }>>
  fallbacks: Partial<Record<ViewName, ReactNode>>
  loads: ViewName[]
} {
  const loads: ViewName[] = []
  const fallbacks = viewFallbacks()
  const fixture = `${appSource}\nexport const startupViews = { ChatView, AnalysisView }\nexport const startupFallbacks = {${Object.entries(
    fallbacks
  )
    .map(([name, expression]) => `${name}: (${expression})`)
    .join(',')}}`
  const code = ts.transpileModule(fixture, {
    fileName: 'App.tsx',
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX
    }
  }).outputText
  const exports: {
    startupViews?: Record<ViewName, ComponentType<{ marker: string }>>
    startupFallbacks?: Partial<Record<ViewName, ReactNode>>
  } = {}
  new Function('require', 'exports', code)((name: string) => {
    if (name === 'react' || name === 'react/jsx-runtime' || name === '@mui/material') {
      return require(name)
    }
    const viewName = (Object.keys(viewModules) as ViewName[]).find(
      (view) => viewModules[view] === name
    )
    if (viewName) {
      loads.push(viewName)
      return {
        default: ({ marker }: { marker: string }) =>
          createElement('article', { 'data-view': viewName }, marker)
      }
    }
    if (name === './lib/windowChromeLayout') return { WINDOW_TITLEBAR_HEIGHT: 44 }
    return {}
  }, exports)
  assert.ok(exports.startupViews)
  return {
    views: exports.startupViews,
    fallbacks: exports.startupFallbacks ?? {},
    loads
  }
}

test('App boot does not load chat or analysis UI modules before selecting a surface', () => {
  const app = loadAppModule()
  assert.deepEqual(app.loads, [])
})

for (const view of Object.keys(viewModules) as ViewName[]) {
  test(`${view} loads only when rendered and preserves its props and local loading surface`, async () => {
    const app = loadAppModule()
    assert.ok(app.fallbacks[view], `${view} needs a local loading surface`)
    const element = createElement(
      Suspense,
      { fallback: app.fallbacks[view] },
      createElement(app.views[view], { marker: `${view} ready` })
    )
    const loading = renderToStaticMarkup(element)
    assert.match(loading, /role="status"/)
    assert.match(loading, /aria-live="polite"/)
    assert.match(loading, /正在加载/)
    assert.doesNotMatch(loading, /data-view=/)

    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(app.loads, [view])
    assert.match(renderToStaticMarkup(element), new RegExp(`data-view="${view}"`))
    assert.match(renderToStaticMarkup(element), new RegExp(`${view} ready`))
    assert.deepEqual(app.loads, [view], 're-rendering reuses the loaded UI module')
  })
}
