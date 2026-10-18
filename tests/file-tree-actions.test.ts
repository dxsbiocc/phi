import { beforeEach } from 'node:test'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileTreeRow } from '../src/renderer/src/features/file-preview/components/FileTreeRow'
import { ProjectFileTree } from '../src/renderer/src/features/file-preview/components/ProjectFileTree'
import {
  fileTreeDisplayPath,
  fileTreeEntryActions,
  fileTreeParentPath,
  fileTreePathInSubtree,
  fileTreeRenameError
} from '../src/renderer/src/features/file-preview/lib/fileTreeActions'
import type { DirectoryListing, FileTreeEntry } from '../src/renderer/src/types'

const local: FileTreeEntry = {
  path: '/project/results/counts.tsv',
  name: 'counts.tsv',
  displayPath: 'results/counts.tsv',
  kind: 'file'
}
const remote: FileTreeEntry = { ...local, path: 'ssh://cluster/project/results/counts.tsv' }
const actions = {
  onRenameFile: async () => undefined,
  onDeleteFile: async () => undefined,
  onDownloadFile: () => undefined,
  onRevealFile: () => undefined
}

test('tree action availability separates local reveal and remote file download', () => {
  assert.deepEqual(fileTreeEntryActions(local, '/project', actions), [
    'open',
    'reveal',
    'copy',
    'rename',
    'delete'
  ])
  assert.deepEqual(fileTreeEntryActions(remote, 'ssh://cluster/project', actions), [
    'open',
    'download',
    'copy',
    'rename',
    'delete'
  ])
  assert.deepEqual(
    fileTreeEntryActions({ ...remote, kind: 'directory' }, 'ssh://cluster/project', actions),
    ['open', 'copy', 'rename', 'delete']
  )
  assert.deepEqual(fileTreeEntryActions(remote, 'ssh://cluster/project'), ['open', 'copy'])
})

test('project roots and unauthorized result paths have no destructive menu actions', () => {
  assert.deepEqual(fileTreeEntryActions(local, local.path, actions), ['open', 'reveal', 'copy'])
  assert.deepEqual(
    fileTreeEntryActions(local, '/project', { ...actions, canModifyFile: () => false }),
    ['open', 'reveal', 'copy']
  )
})

test('file tooltips and copied paths retain full paths with readable remote characters', () => {
  assert.equal(fileTreeDisplayPath(local), '/project/results/counts.tsv')
  assert.equal(
    fileTreeDisplayPath({ ...remote, path: 'ssh://cluster/work/%E6%95%B0%E6%8D%AE/a%20b.csv' }),
    'cluster:/work/数据/a b.csv'
  )
})

test('rename validation rejects traversal and control characters but preserves ordinary names', () => {
  for (const name of [
    '',
    '  ',
    '.',
    '..',
    '../data',
    'data/new',
    'data\\new',
    'data\0new',
    'data\nnew',
    'data\uFFFD',
    'data\uD800',
    'data\uDC00',
    '数'.repeat(86)
  ]) {
    assert.notEqual(fileTreeRenameError(name), '', name)
  }
  for (const name of ['data.tsv', '新数据 1.tsv', '.gitignore', ' a file ', '🧬数据.txt'])
    assert.equal(fileTreeRenameError(name), '')
})

test('tree refresh boundaries preserve siblings and remote URI encoding', () => {
  assert.equal(fileTreeParentPath('/file.txt'), '/')
  assert.equal(fileTreeParentPath('ssh://cluster/file.txt'), 'ssh://cluster/')
  assert.equal(fileTreeParentPath('ssh://cluster/work/a%20b/file.txt'), 'ssh://cluster/work/a%20b')
  assert.equal(fileTreePathInSubtree('/work/data/child', '/work/data'), true)
  assert.equal(fileTreePathInSubtree('/work/data2/child', '/work/data'), false)
})

test('remote download controls are sibling buttons that keep the ordinary file and drop targets', () => {
  const markup = renderToStaticMarkup(
    createElement(FileTreeRow, {
      entry: remote,
      depth: 1,
      isExpanded: false,
      isActive: false,
      onClick: () => undefined,
      onDownload: () => undefined
    })
  )
  assert.match(markup, /aria-label="下载 counts.tsv"/)
  assert.match(markup, /data-phi-file-path="ssh:\/\/cluster\/project\/results\/counts.tsv"/)
  assert.doesNotMatch(
    markup,
    /<button[^>]*>[\s\S]*?<button[^>]*>[\s\S]*?<\/button>[\s\S]*?<\/button>/
  )
  assert.doesNotMatch(markup, /title="results\/counts.tsv"/)
})

test('download buttons appear on remote files without adding actions to folders or local files', () => {
  const rootPath = 'ssh://cluster/project'
  const listing: DirectoryListing = {
    path: rootPath,
    name: 'project',
    displayPath: '/project',
    rootPath,
    rootLabel: 'project',
    truncated: false,
    entries: [
      remote,
      { ...remote, path: `${rootPath}/folder`, name: 'folder', kind: 'directory' },
      local
    ]
  }
  const markup = renderToStaticMarkup(
    createElement(ProjectFileTree, {
      rootPath,
      activePath: '',
      initialListing: listing,
      onOpenFile: () => undefined,
      onListDirectory: async () => listing,
      fileActions: actions
    })
  )
  assert.equal((markup.match(/aria-label="下载 counts.tsv"/g) ?? []).length, 1)
  assert.doesNotMatch(markup, /aria-label="下载 folder"/)
})

// Legacy assertions exercise the Chinese interface explicitly.
beforeEach(() => setUiLanguage('zh-CN'))
