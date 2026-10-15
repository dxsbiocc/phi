import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import {
  ComposerTextEditor,
  type ComposerTextEditorHandle
} from '../src/renderer/src/features/chat/components/ComposerTextEditor'

test('composer editor renders an SSR-safe host without modifying or rendering source markup', () => {
  const inputRef = createRef<ComposerTextEditorHandle>()
  const value = '请用 $scanpy 分析\n<script>alert(1)</script>'
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ComposerTextEditor, {
        value,
        resources: [],
        placeholder: '输入消息',
        placeholderKind: 'default',
        inputRef,
        onChange: () => assert.fail('SSR must not emit document changes')
      })
    )
  )
  assert.match(markup, /data-phi-composer-editor="codemirror"/)
  assert.match(markup, /data-phi-placeholder-kind="default"/)
  assert.doesNotMatch(markup, /<script|<textarea|data-phi-reference-kind=/)
  assert.equal(inputRef.current, null)
})
