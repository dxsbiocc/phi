import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import NotebookOutputArea from '../src/renderer/src/features/analysis/notebook/NotebookOutputArea'
import { notebookOutputText } from '../src/renderer/src/features/analysis/notebook/notebookOutputUtils'
import type { NotebookOutput } from '../src/shared/notebookDocument'

function stream(text: string): NotebookOutput {
  return { outputType: 'stream', name: 'stdout', text, data: {}, metadata: {}, extra: {} }
}

function renderArea(props: Parameters<typeof NotebookOutputArea>[0]): string {
  return renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, createElement(NotebookOutputArea, props))
  )
}

test('multiple output blocks share one copy, wrap and clear toolbar beside the timestamp', () => {
  const markup = renderArea({
    outputs: [stream('first block'), stream('second block')],
    executionCompletedAt: '2026-10-15T12:07:11.000Z',
    onClearOutputs: () => undefined
  })

  for (const action of ['toolbar', 'copy', 'wrap-toggle', 'clear']) {
    assert.equal(
      (markup.match(new RegExp(`data-phi-notebook-output-${action}="true"`, 'g')) ?? []).length,
      1
    )
  }
  assert.match(markup, /data-phi-notebook-output-header="true"/)
  assert.ok(markup.indexOf('data-phi-notebook-output-header') < markup.indexOf('<time'))
  assert.ok(markup.indexOf('data-phi-notebook-output-toolbar') < markup.indexOf('first block'))
  assert.equal((markup.match(/data-phi-notebook-output-pre="true"/g) ?? []).length, 2)
})

test('running output has a toolbar header before the completion time is available', () => {
  const markup = renderArea({ outputs: [], isRunning: true, onClearOutputs: () => undefined })

  assert.match(markup, /data-phi-notebook-output-header="true"/)
  assert.match(markup, /data-phi-notebook-output-toolbar="true"/)
  assert.doesNotMatch(markup, /<time/)
  assert.match(markup, /disabled=""[^>]*data-phi-notebook-output-clear="true"/)
})

test('read-only output retains copy and wrap while disabling clear', () => {
  const markup = renderArea({ outputs: [stream('read-only')] })

  assert.match(markup, /data-phi-notebook-output-copy="true"/)
  assert.match(markup, /data-phi-notebook-output-wrap-toggle="true"/)
  assert.match(markup, /disabled=""[^>]*data-phi-notebook-output-clear="true"/)
})

test('copy includes full stream chunks and one readable representation of each output', () => {
  const longText = Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n')
  const outputs: NotebookOutput[] = [
    stream('loading'),
    stream(' complete\n'),
    {
      outputType: 'execute_result',
      data: { 'text/html': '<b>rich representation</b>', 'text/plain': longText },
      metadata: {},
      extra: {}
    },
    {
      outputType: 'error',
      ename: 'ValueError',
      evalue: 'invalid value',
      traceback: ['Traceback line'],
      data: {},
      metadata: {},
      extra: {}
    }
  ]

  assert.equal(
    notebookOutputText(outputs),
    `loading complete\n\n\n${longText}\n\nValueError: invalid value\nTraceback line`
  )
})

test('copy falls back to readable HTML or JSON while omitting binary media', () => {
  const outputs: NotebookOutput[] = [
    {
      outputType: 'display_data',
      data: { 'image/png': 'base64-image-payload' },
      metadata: {},
      extra: {}
    },
    {
      outputType: 'display_data',
      data: { 'text/html': '<table><tr><td>A</td><td>3</td></tr></table>' },
      metadata: {},
      extra: {}
    },
    {
      outputType: 'display_data',
      data: { 'application/json': { count: 3 } },
      metadata: {},
      extra: {}
    }
  ]

  assert.equal(notebookOutputText(outputs), 'A 3\n\n{\n  "count": 3\n}')
})

test('copy preserves JSON arrays as JSON instead of dropping numeric elements', () => {
  assert.equal(
    notebookOutputText([
      {
        outputType: 'display_data',
        data: { 'application/json': [1, 2, 3] },
        metadata: {},
        extra: {}
      }
    ]),
    '[\n  1,\n  2,\n  3\n]'
  )
})

test('output header hover actions stay available through keyboard focus', () => {
  const markup = renderArea({ outputs: [stream('keyboard accessible')] })

  assert.match(markup, /:hover \.notebook-output-hover-actions/)
  assert.match(markup, /:focus-within \.notebook-output-hover-actions/)
  assert.match(markup, /opacity:0/)
  assert.match(markup, /pointer-events:none/)
  assert.match(markup, /aria-pressed="false"/)
})
