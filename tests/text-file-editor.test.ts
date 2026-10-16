import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { FilePreviewBody } from '../src/renderer/src/features/file-preview/components/FilePreviewBody'
import {
  createTextFileDraftStore,
  textFileDraftIsDirty
} from '../src/renderer/src/features/file-preview/lib/textFileDrafts'
import type { FilePreview } from '../src/renderer/src/types'
import type { FileTreeActions } from '../src/renderer/src/features/file-preview/lib/fileTreeActions'

function renderFile(
  name: string,
  options: { readonly?: boolean; truncated?: boolean; bytes?: number } = {}
): string {
  const content = name.endsWith('.csv')
    ? 'Gene,Value\nTP53,2.4\n'
    : name.endsWith('.html')
      ? '<h1>Report</h1><script>bad()</script>'
      : 'Alpha text'
  const file = {
    path: `/project/${name}`,
    name,
    displayPath: name,
    rootPath: '/project',
    rootLabel: 'project',
    content,
    bytes: options.bytes ?? content.length,
    previewBytes: content.length,
    truncated: options.truncated ?? false,
    ...(name.endsWith('.html')
      ? { kind: 'html', mimeType: 'text/html' }
      : { kind: 'text', mimeType: 'text/plain' })
  } as Extract<FilePreview, { kind: 'text' | 'html' }>
  const actions: FileTreeActions = {
    canModifyFile: () => !options.readonly,
    onSaveTextFile: async (path, content) => ({ path, content, bytes: content.length })
  }
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(FilePreviewBody, {
        state: { status: 'ready', file },
        fileActions: actions,
        onOpenFile: () => undefined,
        onListDirectory: async () => {
          throw new Error('unused')
        }
      })
    )
  )
}

test('text files edit directly while structured formats preserve their default readers', () => {
  for (const name of [
    'notes.txt',
    'data.json',
    'analysis.py',
    'config.yaml',
    'script.sh',
    'LICENSE',
    '.gitignore',
    'table.csv',
    'report.html'
  ]) {
    const markup = renderFile(name)
    assert.match(markup, /data-phi-text-file="true"/, name)
    assert.match(markup, /aria-label="搜索文件内容"/, name)
    assert.doesNotMatch(markup, /value="(?:edit|read)"|role="status"/, name)
    assert.match(markup, /aria-label="保存文件"/, name)
    if (name.endsWith('.csv')) assert.match(markup, /data-phi-spreadsheet-preview="true"/)
    else if (name.endsWith('.html')) {
      assert.match(markup, /data-phi-html-report-preview="true"/)
      assert.match(markup, /sandbox=""/)
      assert.doesNotMatch(markup, /<script>/)
    } else assert.match(markup, /data-phi-text-source-editor="codemirror"/)
  }
})

test('incomplete, large and unbound text previews keep search while disabling edits', () => {
  for (const options of [{ readonly: true }, { truncated: true }, { bytes: 320001 }]) {
    const markup = renderFile('notes.txt', options)
    assert.match(markup, /aria-label="搜索文件内容"/)
    assert.doesNotMatch(markup, /aria-label="保存文件"|role="status"|value="edit"/)
  }
})

test('generic drafts keep source edits across navigation and protect external-change baselines', () => {
  const store = createTextFileDraftStore()
  for (const path of [
    '/project/config.json',
    '/project/code.py',
    '/project/.gitignore',
    'ssh://cluster/project/report.html'
  ]) {
    store.getState().edit(path, 'Original\r\n', 'My edit\n')
    store.getState().release(path)
    store.getState().sync(path, 'External edit\n')
    const submitted = store.getState().beginSave(path)!
    assert.equal(submitted.baseContent, 'Original\r\n')
    store.getState().edit(path, 'External edit\n', 'Newer edit\n')
    store.getState().saved(path, submitted.content, 'My edit\r\n')
    assert.equal(store.getState().drafts[path].content, 'Newer edit\n')
    assert.equal(textFileDraftIsDirty(store.getState().drafts[path]), true)
  }
})
