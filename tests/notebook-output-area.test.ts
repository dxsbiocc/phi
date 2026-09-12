import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import NotebookOutputArea from '../src/renderer/src/features/analysis/notebook/NotebookOutputArea'
import { normalizeLatexDelimiters } from '../src/renderer/src/features/analysis/notebook/notebookOutputUtils'
import type { NotebookOutput } from '../src/shared/notebookDocument'

function renderOutputs(outputs: NotebookOutput[]): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(NotebookOutputArea, { outputs })
    )
  )
}

function latexOutput(text: string): NotebookOutput {
  return {
    outputType: 'execute_result',
    data: { 'text/latex': text },
    metadata: {},
    extra: {}
  }
}

test('normalizeLatexDelimiters upgrades a single-dollar wrap (e.g. sympy) to $$...$$', () => {
  assert.equal(
    normalizeLatexDelimiters('$\\displaystyle x^{2} + 1$'),
    '$$\\displaystyle x^{2} + 1$$'
  )
})

test('normalizeLatexDelimiters leaves an already-doubled $$...$$ wrap alone', () => {
  assert.equal(normalizeLatexDelimiters('$$x^2$$'), '$$x^2$$')
})

test('normalizeLatexDelimiters converts MathJax-style \\[...\\] / \\(...\\) to $$...$$', () => {
  assert.equal(normalizeLatexDelimiters('\\[x^2 + 1\\]'), '$$x^2 + 1$$')
  assert.equal(normalizeLatexDelimiters('\\(x^2\\)'), '$$x^2$$')
})

test('normalizeLatexDelimiters wraps undelimited LaTeX source in $$...$$', () => {
  assert.equal(normalizeLatexDelimiters('x^2 + 1'), '$$x^2 + 1$$')
})

test('a text/latex kernel output renders as an actual KaTeX formula', () => {
  const markup = renderOutputs([latexOutput('$\\displaystyle \\frac{d}{dx} x^2 = 2x$')])

  assert.match(markup, /class="katex"/)
  assert.match(markup, /data-phi-notebook-output-kind="text\/latex"/)
})

test('a multi-line text/latex output (array of strings) is joined, not JSON-stringified', () => {
  const output: NotebookOutput = {
    outputType: 'execute_result',
    data: { 'text/latex': ['$x^2$'] },
    metadata: {},
    extra: {}
  }
  const markup = renderOutputs([output])

  assert.match(markup, /class="katex"/)
})
