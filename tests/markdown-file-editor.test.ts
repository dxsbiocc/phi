import { beforeEach } from 'node:test'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import {
  createMarkdownDraftStore,
  markdownDraftIsDirty
} from '../src/renderer/src/features/file-preview/lib/markdownDrafts'
import {
  isMarkdownFilePath,
  markdownContentsEqual,
  markdownDirectory
} from '../src/renderer/src/features/file-preview/lib/markdownFiles'
import { FilePreviewBody } from '../src/renderer/src/features/file-preview/components/FilePreviewBody'
import { useWorkspaceFileActions } from '../src/renderer/src/features/file-preview/hooks/useWorkspaceFileActions'
import type { RendererApi } from '../src/renderer/src/types'
import type { FileTreeActions } from '../src/renderer/src/features/file-preview/lib/fileTreeActions'
import type { FilePreviewPanelState } from '../src/renderer/src/features/file-preview/lib/filePreviewState'

test('Markdown files render headings, GFM tables and inline formatting by default without executing HTML', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(FilePreviewBody, {
        state: {
          status: 'ready',
          file: {
            kind: 'text',
            mimeType: 'text/plain',
            path: '/project/readme.md',
            name: 'readme.md',
            displayPath: 'readme.md',
            rootPath: '/project',
            rootLabel: 'project',
            bytes: 200,
            previewBytes: 200,
            truncated: false,
            content:
              '# Live heading\n\n**important**\n\n| Gene | Value |\n| --- | --- |\n| TP53 | 2 |\n\n<script>alert(1)</script>'
          }
        },
        onOpenFile: () => undefined,
        onListDirectory: async () => {
          throw new Error('not used')
        }
      })
    )
  )
  assert.match(markup, /data-phi-markdown-file="true"/)
  assert.match(markup, /<h1[^>]*>Live heading<\/h1>/)
  assert.match(markup, /<strong[^>]*>important<\/strong>/)
  assert.match(markup, /<table[\s>]/)
  assert.doesNotMatch(markup, /<script|data-phi-code-preview-mode/)
})

test('Markdown path recognition handles uppercase and encoded remote names', () => {
  assert.equal(isMarkdownFilePath('/project/NOTES.MARKDOWN'), true)
  assert.equal(isMarkdownFilePath('ssh://cluster/project/read%20me.md'), true)
  assert.equal(isMarkdownFilePath('/project/notes.mdown'), true)
  assert.equal(isMarkdownFilePath('/project/notes.md.py'), false)
  assert.equal(isMarkdownFilePath('ssh://[invalid/notes.md'), false)
  assert.equal(markdownDirectory('ssh://cluster/project/my%20notes/readme.md'), '/project/my notes')
})

test('dirty drafts survive file navigation and external refresh without losing their save baseline', () => {
  const store = createMarkdownDraftStore()
  store.getState().sync('a.md', '# Original')
  store.getState().edit('a.md', '# Original', '# My edit')
  store.getState().release('a.md')
  store.getState().sync('b.md', '# Other file')
  store.getState().sync('a.md', '# External edit')
  assert.equal(store.getState().drafts['a.md'].content, '# My edit')
  assert.equal(store.getState().beginSave('a.md')?.baseContent, '# Original')
})

test('failed saves preserve text and permit retry while duplicate saves are rejected', () => {
  const store = createMarkdownDraftStore()
  store.getState().edit('a.md', '# Before', '# After')
  assert.ok(store.getState().beginSave('a.md'))
  assert.equal(store.getState().beginSave('a.md'), null)
  store.getState().failed('a.md', 'File changed externally')
  assert.equal(store.getState().drafts['a.md'].content, '# After')
  assert.equal(store.getState().drafts['a.md'].error, 'File changed externally')
  assert.ok(store.getState().beginSave('a.md'))
})

test('typing during a save keeps new edits dirty and advances the baseline to actually saved content', () => {
  const store = createMarkdownDraftStore()
  store.getState().edit('a.md', '# Before', '# Submitted')
  store.getState().beginSave('a.md')
  store.getState().edit('a.md', '# Before', '# Newer edit')
  store.getState().saved('a.md', '# Submitted', '# Submitted')
  assert.equal(store.getState().drafts['a.md'].content, '# Newer edit')
  assert.equal(store.getState().drafts['a.md'].baseContent, '# Submitted')
  assert.equal(markdownDraftIsDirty(store.getState().drafts['a.md']), true)
})

test('saved line endings compare cleanly and clean drafts are released', () => {
  const store = createMarkdownDraftStore()
  store.getState().edit('a.md', '# Before\r\n', '# After\n')
  store.getState().beginSave('a.md')
  store.getState().saved('a.md', '# After\n', '# After\r\n')
  assert.equal(markdownDraftIsDirty(store.getState().drafts['a.md']), false)
  assert.equal(markdownContentsEqual('# Same\r\n', '# Same\n'), true)
  store.getState().release('a.md')
  assert.equal(store.getState().drafts['a.md'], undefined)
})

test('discarding modifications restores the latest file content', () => {
  const store = createMarkdownDraftStore()
  store.getState().edit('a.md', '# Before', '# Draft')
  store.getState().discard('a.md', '# Latest read')
  assert.equal(store.getState().drafts['a.md'].content, '# Latest read')
  assert.equal(markdownDraftIsDirty(store.getState().drafts['a.md']), false)
})

test('draft storage integration recovers unsaved edits and surfaces quota failures without losing text', () => {
  let stored: string | null = null
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      stored = value
    }
  }
  const first = createMarkdownDraftStore(storage)
  first.getState().edit('/project/a.md', '# Before', '# Recover me')
  const restored = createMarkdownDraftStore(storage)
  assert.equal(restored.getState().drafts['/project/a.md'].content, '# Recover me')
  const full = createMarkdownDraftStore({
    getItem: () => null,
    setItem: () => {
      throw new Error('quota')
    }
  })
  full.getState().edit('/project/a.md', '# Before', '# Keep me')
  assert.equal(full.getState().drafts['/project/a.md'].content, '# Keep me')
  assert.match(full.getState().persistenceError ?? '', /无法保存本地文本草稿/)
})

test('oversized pasted content does not replace the recoverable draft', () => {
  const store = createMarkdownDraftStore()
  store.getState().edit('/project/a.md', '# Before', '你'.repeat(120_000))
  assert.equal(store.getState().drafts['/project/a.md'].content, '# Before')
  assert.match(store.getState().drafts['/project/a.md'].error ?? '', /大小上限/)
})

test('saving while the same preview is reloading cancels the old read and publishes the saved version', async () => {
  let finish!: (value: { path: string; content: string; bytes: number }) => void
  const path = '/project/a.md'
  const initial: FilePreviewPanelState = {
    status: 'ready',
    file: {
      kind: 'text',
      mimeType: 'text/plain',
      path,
      name: 'a.md',
      displayPath: 'a.md',
      rootPath: '/project',
      rootLabel: 'project',
      content: '# Before',
      bytes: 8,
      previewBytes: 8,
      truncated: false
    }
  }
  let displayed: FilePreviewPanelState | null = initial
  let tabDirty = true
  const workspace = {
    filePreview: displayed as FilePreviewPanelState | null,
    filePreviewCache: { [path]: initial },
    workspaceFileTabs: [
      {
        id: path,
        path,
        name: 'a.md',
        status: 'ready' as const,
        kind: 'file' as const,
        pathKind: 'file' as const
      }
    ],
    activeWorkspaceFilePath: path,
    setFilePreview: (state: FilePreviewPanelState | null) => {
      displayed = state
    },
    clearCachedFilePreview: () => undefined,
    setWorkspaceFileTabs: () => {
      tabDirty = false
    },
    setActiveWorkspaceFilePath: () => undefined,
    filePreviewRequestRef: { current: 4 }
  }
  let actions!: FileTreeActions
  const api = {
    saveTextFile: () =>
      new Promise((resolve) => {
        finish = resolve
      })
  } as unknown as RendererApi
  function Harness(): null {
    actions = useWorkspaceFileActions({
      rootPath: '/project',
      rendererApi: api,
      getActiveCwd: () => '/project',
      getActiveRemoteProject: () => null,
      workspace,
      onChanged: () => undefined,
      onOpenFile: () => undefined,
      onOpenDirectory: () => undefined,
      onDownloadFile: () => undefined,
      onRevealFile: () => undefined
    })
    return null
  }
  renderToStaticMarkup(createElement(Harness))
  const save = actions.onSaveTextFile!(path, '# Saved', '# Before')
  workspace.filePreview = { status: 'loading', path }
  const staleRead = ++workspace.filePreviewRequestRef.current
  finish({ path, content: '# Saved', bytes: 7 })
  await save
  assert.equal(workspace.filePreviewRequestRef.current, staleRead + 1)
  assert.equal(displayed?.status === 'ready' ? displayed.file.content : null, '# Saved')
  assert.equal(tabDirty, true)
})

// Legacy assertions exercise the Chinese interface explicitly.
beforeEach(() => setUiLanguage('zh-CN'))
