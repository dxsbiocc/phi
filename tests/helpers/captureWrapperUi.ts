import assert from 'node:assert/strict'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/** Capture handlers while invoking the component within React's hook dispatcher. */
export function captureWrapperUi(render: () => ReactElement): ReactElement {
  let captured: ReactElement | undefined
  function Capture(): null {
    captured = render()
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  assert.ok(captured)
  return captured
}
