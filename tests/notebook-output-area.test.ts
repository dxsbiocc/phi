import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

test('stderr stream output collapses behind a stderr button by default', () => {
  const output: NotebookOutput = {
    outputType: 'stream',
    name: 'stderr',
    text: 'Loading required package: ggplot2\nWarning message:\npackage was built under R 4.4.0\n',
    data: {},
    metadata: {},
    extra: {}
  }
  const markup = renderOutputs([output])

  assert.match(markup, /data-phi-notebook-output-stderr="true"/)
  assert.match(markup, /data-phi-notebook-output-stderr-collapsed="true"/)
  assert.match(markup, /data-phi-notebook-output-stderr-toggle="true"/)
  assert.match(markup, /aria-expanded="false"/)
  assert.match(markup, />stderr</)
  assert.doesNotMatch(markup, /Loading required package/)
  assert.doesNotMatch(markup, /Warning message/)
})

test('stderr output expansion stretches the content pane while keeping the stderr button left aligned', () => {
  const source = readFileSync(
    resolve('src/renderer/src/features/analysis/notebook/NotebookOutputArea.tsx'),
    'utf-8'
  )

  assert.match(source, /data-phi-notebook-output-stderr="true"[\s\S]*?justifyItems: 'stretch'/)
  assert.match(source, /data-phi-notebook-output-stderr-toggle="true"[\s\S]*?justifySelf: 'start'/)
  assert.match(source, /<NotebookPreOutput hideKindLabel kind="stream:stderr" text=\{text\} \/>/)
})

test('stderr stream output that looks like a real error stays visible', () => {
  const output: NotebookOutput = {
    outputType: 'stream',
    name: 'stderr',
    text: "Error in eval(expr, envir, enclos): object 'x' not found\nExecution halted\n",
    data: {},
    metadata: {},
    extra: {}
  }
  const markup = renderOutputs([output])

  assert.match(markup, /data-phi-notebook-output-kind="stream:stderr"/)
  assert.match(markup, /Error in eval/)
  assert.doesNotMatch(markup, /data-phi-notebook-output-stderr-collapsed/)
})

test('kernel error output remains directly visible', () => {
  const output: NotebookOutput = {
    outputType: 'error',
    ename: 'RuntimeError',
    evalue: 'boom',
    traceback: ['Traceback line'],
    data: {},
    metadata: {},
    extra: {}
  }
  const markup = renderOutputs([output])

  assert.match(markup, /data-phi-notebook-output-kind="error"/)
  assert.match(markup, /RuntimeError: boom/)
  assert.match(markup, /Traceback line/)
  assert.doesNotMatch(markup, /data-phi-notebook-output-stderr-collapsed/)
})

test('notebook output area uses marimo-style flow-root scrolling layout', () => {
  const source = readFileSync(
    resolve('src/renderer/src/features/analysis/notebook/NotebookOutputArea.tsx'),
    'utf-8'
  )

  assert.match(source, /data-phi-notebook-output="area"/)
  assert.match(source, /maxWidth: 'inherit'/)
  assert.match(source, /p: 2/)
  assert.match(source, /clear: 'both'/)
  assert.match(source, /display: 'flow-root'/)
  assert.match(source, /overflow: 'auto'/)
})
