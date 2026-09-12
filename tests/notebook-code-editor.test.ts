import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import NotebookCodeEditor from '../src/renderer/src/features/analysis/notebook/NotebookCodeEditor'

test('notebook code editor renders a codemirror mount for the selected language', () => {
  const theme = createTheme()
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(NotebookCodeEditor, {
        value: 'print("hello")',
        language: 'python',
        onChange: () => undefined,
        onRun: () => undefined,
        onRequestClose: () => undefined
      })
    )
  )

  assert.match(markup, /data-phi-notebook-code-editor="codemirror"/)
  assert.match(markup, /data-phi-notebook-code-theme="phi"/)
  assert.match(markup, /data-phi-syntax-language="python"/)
})

test('notebook code editor keeps the caret visible in dark themes', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/notebook/NotebookCodeEditor.tsx'),
    'utf8'
  )

  assert.match(source, /function notebookEditorCaretColor/)
  assert.match(source, /theme\.palette\.mode === 'dark' \? theme\.palette\.primary\.light/)
  assert.match(source, /caretColor/)
  assert.match(source, /\.cm-cursor, \.cm-dropCursor/)
  assert.match(source, /borderLeftColor: `\$\{caretColor\} !important`/)
})
