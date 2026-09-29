import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'
import { McpToolList } from '../src/renderer/src/features/mcp/components/McpToolList'

function render(props: {
  requiresSignIn: boolean
  loading: boolean
  names: string[] | null
  error: string | null
}): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpToolList, { ...props, onRetry: () => undefined })
    )
  )
}

test('connected MCP tool list shows every server-provided name', () => {
  const names = ['search_preprints', 'get_preprint', 'get_categories', 'search_by_funder']
  const markup = render({ requiresSignIn: false, loading: false, names, error: null })
  for (const name of names) assert.match(markup, new RegExp(name))
  assert.match(markup, /服务端工具 · 4/)
})

test('unauthorized connector does not show guessed tool names', () => {
  const markup = render({ requiresSignIn: true, loading: false, names: null, error: null })
  assert.match(markup, /尚未授权，无法读取/)
  assert.doesNotMatch(markup, /search_preprints/)
})
