import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fileTreeRevealScrollCorrection,
  fileTreeRevealPaths,
  normalizeAbsoluteTreePath,
  resolveFuzzyTreePath,
  shouldAutoRevealTreePath,
  shouldRestoreRememberedTreeScroll
} from '../src/renderer/src/features/file-preview/lib/fileTreeReveal'

test('remote directory input normalizes to an absolute tree path', () => {
  assert.equal(normalizeAbsoluteTreePath('/data2//dana/'), '/data2/dana')
  assert.equal(normalizeAbsoluteTreePath('/data2/shared/../dana'), '/data2/dana')
  assert.equal(normalizeAbsoluteTreePath('/'), '/')
  assert.equal(normalizeAbsoluteTreePath('data2/dana'), null)
  assert.equal(normalizeAbsoluteTreePath('/../../outside'), null)
})

test('remote directory input expands every ancestor needed to reveal the selected row', () => {
  assert.deepEqual(fileTreeRevealPaths('/', '/data2/dana'), ['/', '/data2', '/data2/dana'])
  assert.deepEqual(fileTreeRevealPaths('/data2', '/data2/dana/project'), [
    '/data2',
    '/data2/dana',
    '/data2/dana/project'
  ])
  assert.deepEqual(fileTreeRevealPaths('/data2', '/data20/project'), [])
})

test('an explicit path reveal takes priority over remembered tree scroll', () => {
  assert.equal(shouldRestoreRememberedTreeScroll('/data2', false), false)
  assert.equal(shouldRestoreRememberedTreeScroll('', false), true)
  assert.equal(shouldRestoreRememberedTreeScroll('', true), false)
})

test('the same path is repositioned when its loaded tree layout changes', () => {
  assert.equal(shouldAutoRevealTreePath('/data2', '/data2', 'with-children', 'loading'), true)
  assert.equal(shouldAutoRevealTreePath('/data2', '/data2', 'stable', 'stable'), false)
  assert.equal(shouldAutoRevealTreePath('/data2', '', 'stable', ''), true)
  assert.equal(shouldAutoRevealTreePath('', '/data2', '', 'stable'), false)
})

test('virtual tree reveal corrects the estimated scroll using real row geometry', () => {
  assert.equal(
    fileTreeRevealScrollCorrection({
      containerTop: 100,
      containerHeight: 200,
      targetTop: 10,
      targetHeight: 32
    }),
    -174
  )
  assert.equal(
    fileTreeRevealScrollCorrection({
      containerTop: 100,
      containerHeight: 200,
      targetTop: 184,
      targetHeight: 32
    }),
    0
  )
})

test('partial remote paths fuzzy-match existing folders without probing a missing path', async () => {
  const calls: string[] = []
  const entries = new Map([
    ['/', [{ name: 'data', path: '/data' }]],
    [
      '/data',
      [
        { name: 'dana', path: '/data/dana' },
        { name: 'dhr', path: '/data/dhr' },
        { name: 'shared', path: '/data/shared' }
      ]
    ]
  ])

  const matched = await resolveFuzzyTreePath('/data/d', async (path) => {
    calls.push(path)
    return entries.get(path) ?? []
  })

  assert.equal(matched, '/data/dana')
  assert.deepEqual(calls, ['/', '/data'])
  assert.equal(calls.includes('/data/d'), false)
})

test('fuzzy path matching supports contains and subsequence matches without invalid reads', async () => {
  const entries = new Map([
    [
      '/',
      [
        { name: 'research-data', path: '/research-data' },
        { name: 'shared', path: '/shared' }
      ]
    ],
    ['/research-data', [{ name: 'dana', path: '/research-data/dana' }]]
  ])
  const list = async (path: string): Promise<readonly { name: string; path: string }[]> =>
    entries.get(path) ?? []

  assert.equal(await resolveFuzzyTreePath('/data/dna', list), '/research-data/dana')
  assert.equal(await resolveFuzzyTreePath('/missing', list), '/')
})
