import { beforeEach } from 'node:test'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectFileTree } from '../src/renderer/src/features/file-preview/components/ProjectFileTree'
import { FileTreeRow } from '../src/renderer/src/features/file-preview/components/FileTreeRow'
import { FileTreeRootRow } from '../src/renderer/src/features/file-preview/components/FileTreeRootRow'

test('the pending directory tree shows loading on its root without adding a text row', () => {
  const markup = renderToStaticMarkup(
    createElement(ProjectFileTree, {
      rootPath: '/server/work',
      activePath: '',
      onOpenFile: () => undefined,
      onListDirectory: () => new Promise<never>(() => undefined),
      variant: 'standalone'
    })
  )
  assert.match(markup, /data-phi-file-tree-root="true"/)
  assert.match(markup, /aria-busy="true"/)
  assert.match(markup, /role="progressbar"/)
  assert.doesNotMatch(markup, /正在读取目录|文件夹为空/)
})

test('a loading folder keeps its name and click target while exposing a progress indicator', () => {
  const props = {
    entry: {
      path: '/server/work/reads',
      name: 'reads',
      displayPath: '/server/work/reads',
      kind: 'directory' as const
    },
    depth: 1,
    isExpanded: true,
    isActive: false,
    onClick: () => undefined
  }
  const loading = renderToStaticMarkup(createElement(FileTreeRow, { ...props, isLoading: true }))
  assert.match(loading, /data-phi-file-path="\/server\/work\/reads"/)
  assert.match(loading, /aria-busy="true"/)
  assert.match(loading, />reads</)
  assert.match(loading, /role="progressbar"/)
  assert.doesNotMatch(loading, /正在读取目录/)
  const ready = renderToStaticMarkup(createElement(FileTreeRow, { ...props, isLoading: false }))
  assert.doesNotMatch(ready, /role="progressbar"|aria-busy="true"/)
})

test('root-row loading can finish without changing its expansion or drop destination', () => {
  const props = {
    rootPath: 'ssh://cluster/work',
    rootName: 'work',
    rootDisplayPath: '/work',
    isExpanded: true,
    isActive: false,
    localDropTargetPath: 'ssh://cluster/work',
    onToggle: () => undefined
  }
  const loading = renderToStaticMarkup(
    createElement(FileTreeRootRow, { ...props, isLoading: true })
  )
  assert.match(loading, /role="progressbar"/)
  assert.match(loading, /aria-expanded="true"/)
  assert.match(loading, /data-phi-file-drop-path="ssh:\/\/cluster\/work"/)
  const ready = renderToStaticMarkup(createElement(FileTreeRootRow, { ...props, isLoading: false }))
  assert.doesNotMatch(ready, /role="progressbar"|aria-busy="true"/)
})

// Legacy assertions exercise the Chinese interface explicitly.
beforeEach(() => setUiLanguage('zh-CN'))
