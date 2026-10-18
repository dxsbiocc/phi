import assert from 'node:assert/strict'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/** Inspect event handlers in a component's element tree while honoring its React hooks. */
export function componentTree(render: () => ReactElement): ReactElement {
  let tree: ReactElement | undefined
  function Capture(): null {
    tree = render()
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  assert.ok(tree)
  return tree
}
