import { fileTreePathInSubtree } from '../src/renderer/src/features/file-preview/lib/fileTreeActions'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertWorkspaceFilesSaved,
  renamedWorkspacePath
} from '../src/renderer/src/features/file-preview/lib/workspaceFileMutations'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

setUiLanguage('zh-CN')

test('folder operations affect descendants but preserve similarly named siblings', () => {
  for (const root of ['/work/data', 'ssh://cluster/work/data']) {
    assert.equal(fileTreePathInSubtree(root, root), true)
    assert.equal(fileTreePathInSubtree(`${root}/nested/file.txt`, root), true)
    assert.equal(fileTreePathInSubtree(`${root}-old/file.txt`, root), false)
    assert.equal(
      renamedWorkspacePath(`${root}/nested/file.txt`, root, `${root}-new`),
      `${root}-new/nested/file.txt`
    )
    assert.equal(
      renamedWorkspacePath(`${root}-old/file.txt`, root, `${root}-new`),
      `${root}-old/file.txt`
    )
  }
})

test('renaming or deleting a parent refuses unsaved descendant notebooks and text files', () => {
  const tabs = [
    { path: '/work/data/notebook.ipynb', dirty: true },
    { path: '/work/data/source.py', dirty: true },
    { path: '/work/data-old/clean.txt' }
  ]
  assert.throws(() => assertWorkspaceFilesSaved('/work/data', tabs), /未保存的修改/)
  assert.throws(() => assertWorkspaceFilesSaved('/work/data/notebook.ipynb', tabs), /未保存的修改/)
  assert.throws(() => assertWorkspaceFilesSaved('/work/data/source.py', tabs), /未保存的修改/)
  assert.doesNotThrow(() => assertWorkspaceFilesSaved('/work/data-old', tabs))
  assert.doesNotThrow(() =>
    assertWorkspaceFilesSaved('/work/data', [{ path: '/work/data/notebook.ipynb', dirty: false }])
  )
})
