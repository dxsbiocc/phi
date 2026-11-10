import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'
import { McpToolList } from '../src/renderer/src/features/mcp/components/McpToolList'
import { mcpToolFailureText } from '../src/shared/mcpToolFailureText'

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
  assert.match(markup, /Server tools · 4/)
  assert.match(markup, /Refresh tools/)
})

test('connector with unverified authorization does not show guessed tool names', () => {
  const markup = render({ requiresSignIn: true, loading: false, names: null, error: null })
  assert.match(markup, /Authorization is unverified/)
  assert.doesNotMatch(markup, /search_preprints/)
  assert.doesNotMatch(markup, /Refresh tools/)
})

test('a long tool list stays collapsed on three aligned columns', () => {
  const names = Array.from({ length: 12 }, (_, index) => `tool_${index}`)
  const markup = render({ requiresSignIn: false, loading: false, names, error: null })
  assert.match(markup, /Server tools · 12/)
  assert.match(markup, /tool_0/)
  assert.match(markup, /tool_8/)
  assert.doesNotMatch(markup, /tool_9/)
  assert.match(markup, /Show all/)
  assert.match(markup, /repeat\(3, minmax\(0, 1fr\)\)/)
})

test('tool list distinguishes an unread server from an empty server', () => {
  const unread = render({ requiresSignIn: false, loading: false, names: null, error: null })
  const empty = render({ requiresSignIn: false, loading: false, names: [], error: null })
  assert.match(unread, /Server tools have not been loaded/)
  assert.match(empty, /The server currently exposes no tools/)
})

test('an HTML HTTP error is reduced to a short status without markup', () => {
  const html = `<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><h1>${'missing '.repeat(200)}</h1></body></html>`
  const text = mcpToolFailureText(new Error(`HTTP 404: ${html}`))
  assert.equal(text, 'HTTP 404')
  assert.doesNotMatch(text, /</)

  const markup = render({
    requiresSignIn: false,
    loading: false,
    names: null,
    error: `HTTP 404: ${html}`
  })
  assert.match(markup, /HTTP 404/)
  const errorText = /Could not read the current tool list: ([^<]*)</.exec(markup)?.[1]?.trim()
  assert.equal(errorText, 'HTTP 404')
  assert.doesNotMatch(errorText ?? '', /</)
  assert.doesNotMatch(markup, /<!DOCTYPE|<html|<body|<h1|missing missing/)
})

test('a plain HTTP error body is capped at 200 characters', () => {
  const text = mcpToolFailureText(new Error(`HTTP 500: ${'x'.repeat(500)}`))
  assert.match(text, /^HTTP 500: /)
  assert.ok(text.length <= 'HTTP 500: '.length + 200)
  assert.doesNotMatch(text, /x{200}/)
})
