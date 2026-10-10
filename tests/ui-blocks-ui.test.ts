import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import test from 'node:test'

import { UiBlocksCard } from '../src/renderer/src/features/chat/components/UiBlocks/UiBlocksCard'
import type { UiBlocksItem } from '../src/renderer/src/features/chat/lib/uiBlocks'

function render(item: UiBlocksItem): string {
  return renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, createElement(UiBlocksCard, { item }))
  )
}

test('ui blocks render HTML-like agent strings as inert text', () => {
  const markup = render({
    id: 'ui-blocks-1',
    role: 'ui_blocks',
    blocks: [
      {
        type: 'steps',
        items: [{ label: '<script>alert(1)</script>', status: 'failed', detail: '**not bold**' }]
      }
    ]
  })

  assert.doesNotMatch(markup, /<script>/u)
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u)
  assert.match(markup, /\*\*not bold\*\*/u)
})

test('invalid replay placeholder renders only the muted unavailable message', () => {
  const markup = render({ id: 'ui-blocks-invalid', role: 'ui_blocks', blocks: null })

  assert.match(markup, /无法显示结构化内容/u)
  assert.doesNotMatch(markup, /table|iframe|script/u)
})
