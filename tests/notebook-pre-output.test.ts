import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import NotebookPreOutput from '../src/renderer/src/features/analysis/notebook/NotebookPreOutput'

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
  assert.match(markup, /overflow-y:auto/)
})

test('many real lines still fold behind a "展开完整输出" toggle', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
  const markup = renderPreOutput('text/plain', text)

  assert.match(markup, /Output folded: 200 lines/)
  assert.match(markup, /展开完整输出/)
  assert.match(markup, /max-height:420px/)
})

test('short output renders without visible truncation UI', () => {
  const markup = renderPreOutput('text/plain', 'hello world')

  assert.doesNotMatch(markup, /Output folded/)
  assert.match(markup, /hello world/)
})

test('plain text output shows no "text/plain" mime label -- it is the unremarkable default case', () => {
  const markup = renderPreOutput('text/plain', '2')

  assert.doesNotMatch(markup, />text\/plain</)
  assert.match(markup, />2</)
  // the copy button should still be there, just not paired with a label
  assert.match(markup, /复制输出/)
})

test('stdout/stderr and error output keep their label -- it actually distinguishes the output', () => {
  const stdout = renderPreOutput('stream:stdout', 'hello')
  const stderr = renderPreOutput('stream:stderr', 'warn')
  const error = renderPreOutput('error', 'boom')

  assert.match(stdout, />stdout</)
  assert.match(stderr, />stderr</)
  assert.match(error, />error</)
})
