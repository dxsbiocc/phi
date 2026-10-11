import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import test from 'node:test'
import { CatalogResourceRow } from '../src/renderer/src/components/CatalogResourceRow'

for (const resource of ['skills', 'wrappers', 'connectors', 'plugins'] as const) {
  test(`${resource}: disclosure follows hover and keyboard focus, not retained mouse focus`, () => {
    const markup = renderToStaticMarkup(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        // eslint-disable-next-line react/no-children-prop -- The component requires children in its typed props.
        createElement(CatalogResourceRow, {
          id: 'example',
          resource,
          label: 'Example',
          icon: createElement('span'),
          children: 'Example',
          enabled: true,
          selected: true,
          onSelect: () => undefined,
          onEnabledChange: () => undefined
        })
      )
    )

    // Mouse clicks keep :focus-within active after the pointer leaves the row.
    assert.doesNotMatch(markup, /:focus-within/)
    assert.match(markup, /:has\(:focus-visible\) \.catalog-enable-control/)
    assert.match(markup, /:has\(:focus-visible\) \.catalog-row-content/)
    assert.match(markup, /aria-current="true"/)
    assert.match(markup, /aria-label="关闭 Example"/)
  })
}

test('a remove button appears beside the switch only when the row can be removed', () => {
  const render = (onRemove?: () => void): string =>
    renderToStaticMarkup(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        // eslint-disable-next-line react/no-children-prop -- The component requires children in its typed props.
        createElement(CatalogResourceRow, {
          id: 'example',
          resource: 'wrappers',
          label: 'Example',
          icon: createElement('span'),
          children: 'Example',
          enabled: true,
          onSelect: () => undefined,
          onEnabledChange: () => undefined,
          ...(onRemove ? { onRemove } : {})
        })
      )
    )
  assert.match(
    render(() => undefined),
    /aria-label="卸载 Example"/
  )
  assert.doesNotMatch(render(), /卸载/)
})
