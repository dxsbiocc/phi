import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fileTreeRevealPaths,
  normalizeAbsoluteTreePath
} from '../src/renderer/src/features/file-preview/lib/fileTreeReveal'

test('remote directory input normalizes to an absolute tree path', () => {
  assert.equal(normalizeAbsoluteTreePath('/data2//dengxsh/'), '/data2/dengxsh')
  assert.equal(normalizeAbsoluteTreePath('/data2/shared/../dengxsh'), '/data2/dengxsh')
  assert.equal(normalizeAbsoluteTreePath('/'), '/')
  assert.equal(normalizeAbsoluteTreePath('data2/dengxsh'), null)
  assert.equal(normalizeAbsoluteTreePath('/../../outside'), null)
})

test('remote directory input expands every ancestor needed to reveal the selected row', () => {
  assert.deepEqual(fileTreeRevealPaths('/', '/data2/dengxsh'), ['/', '/data2', '/data2/dengxsh'])
  assert.deepEqual(fileTreeRevealPaths('/data2', '/data2/dengxsh/project'), [
    '/data2',
    '/data2/dengxsh',
    '/data2/dengxsh/project'
  ])
  assert.deepEqual(fileTreeRevealPaths('/data2', '/data20/project'), [])
})
