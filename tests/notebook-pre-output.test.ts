import { beforeEach } from 'node:test'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import NotebookPreOutput from '../src/renderer/src/features/analysis/notebook/NotebookPreOutput'
import { NotebookOutputWrapContext } from '../src/renderer/src/features/analysis/notebook/notebookOutputContext'

function renderPreOutput(kind: string, text: string): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(NotebookPreOutput, { kind, text })
    )
  )
}

test('a single very long unwrapped line is height-capped and scrollable', () => {
  // e.g. Python's repr() of dir('a') -- no real newlines, but hundreds of
  // characters that word-wrap into dozens of visual rows. The line/char
  // count based fold never triggers for this (it's "1 line"), so without a
  // CSS height cap the block would render as tall as its wrapped content.
  const text = `[${Array.from({ length: 80 }, (_, i) => `'__method_${i}__'`).join(', ')}]`
  const markup = renderPreOutput('text/plain', text)

  assert.match(markup, /max-height:420px/)
  assert.match(markup, /overflow-x:auto/)
  assert.match(markup, /overflow-y:auto/)
  assert.match(markup, /white-space:pre/)
})

test('many real lines still fold behind a "展开完整输出" toggle', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
  const markup = renderPreOutput('text/plain', text)

  assert.match(markup, /输出已折叠：200 行/)
  assert.match(markup, /展开完整输出/)
  assert.match(markup, /max-height:420px/)
})

test('short output renders without visible truncation UI', () => {
  const markup = renderPreOutput('text/plain', 'hello world')

  assert.doesNotMatch(markup, /输出已折叠/)
  assert.match(markup, /hello world/)
})

test('plain text output shows no "text/plain" mime label -- it is the unremarkable default case', () => {
  const markup = renderPreOutput('text/plain', '2')

  assert.doesNotMatch(markup, />text\/plain</)
  assert.match(markup, />2</)
  assert.doesNotMatch(markup, /data-phi-notebook-output-toolbar/)
  assert.doesNotMatch(markup, /data-phi-notebook-output-copy/)
  assert.doesNotMatch(markup, /data-phi-notebook-output-wrap-toggle/)
  assert.match(markup, /data-phi-notebook-output-wrap="false"/)
})

test('stdout output hides its label, while stderr and error keep theirs', () => {
  const stdout = renderPreOutput('stream:stdout', 'hello')
  const stderr = renderPreOutput('stream:stderr', 'warn')
  const error = renderPreOutput('error', 'boom')

  assert.doesNotMatch(stdout, />stdout</)
  assert.match(stdout, />hello</)
  assert.match(stderr, />stderr</)
  assert.match(error, />error</)
})

test('stderr output can hide its inner label when an outer channel button already labels it', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(NotebookPreOutput, {
        hideKindLabel: true,
        kind: 'stream:stderr',
        text: '载入程序包: dplyr'
      })
    )
  )

  assert.doesNotMatch(markup, />stderr</)
  assert.match(markup, /载入程序包/)
})

test('text blocks use the full output width after their toolbars are lifted to the cell header', () => {
  const markup = renderPreOutput('stream:stdout', 'all the available width')

  assert.match(markup, /min-width:0/)
  assert.match(markup, /width:100%/)
  assert.doesNotMatch(markup, /padding-right:56px/)
  assert.doesNotMatch(markup, /notebook-output-hover-actions/)
})

test('the cell wrap preference reaches every text block and nested rich fallback', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(
        NotebookOutputWrapContext.Provider,
        { value: true },
        createElement(NotebookPreOutput, { kind: 'stream:stdout', text: 'stdout' }),
        createElement(NotebookPreOutput, { kind: 'application/json', text: '{"data": 1}' }),
        createElement(NotebookPreOutput, { kind: 'vega:fallback', text: 'fallback' })
      )
    )
  )

  assert.equal((markup.match(/data-phi-notebook-output-wrap="true"/g) ?? []).length, 3)
  assert.match(markup, /white-space:pre-wrap/)
  assert.match(markup, /overflow-wrap:anywhere/)
  assert.doesNotMatch(markup, /data-phi-notebook-output-toolbar/)
})

// Legacy assertions exercise the Chinese interface explicitly.
beforeEach(() => setUiLanguage('zh-CN'))
