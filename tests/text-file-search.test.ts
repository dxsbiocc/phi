import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findTextFileMatches,
  nextTextFileMatch,
  TEXT_SEARCH_MATCH_LIMIT
} from '../src/renderer/src/features/file-preview/lib/textFileSearch'

test('file search is literal, returns source offsets, and respects case sensitivity', () => {
  assert.deepEqual(findTextFileMatches('Alpha alpha ALPHA', 'alpha').matches, [
    { from: 0, to: 5 },
    { from: 6, to: 11 },
    { from: 12, to: 17 }
  ])
  assert.deepEqual(findTextFileMatches('Alpha alpha ALPHA', 'alpha', true).matches, [
    { from: 6, to: 11 }
  ])
  assert.deepEqual(findTextFileMatches('a.b a*b [x] $5', 'a.b').matches, [{ from: 0, to: 3 }])
  assert.deepEqual(findTextFileMatches('a.b a*b [x] $5', '[x]').matches, [{ from: 8, to: 11 }])
})

test('file search handles Unicode, newlines, empty queries and no matches', () => {
  assert.deepEqual(findTextFileMatches('İ 中文\n中文', '中文').matches, [
    { from: 2, to: 4 },
    { from: 5, to: 7 }
  ])
  assert.deepEqual(findTextFileMatches('a\nb', 'a\nb').matches, [{ from: 0, to: 3 }])
  assert.deepEqual(findTextFileMatches('text', ''), { matches: [], limited: false })
  assert.deepEqual(findTextFileMatches('text', 'missing'), { matches: [], limited: false })
})

test('search navigation wraps in both directions and resets invalid positions', () => {
  assert.equal(nextTextFileMatch(3, 2, 1), 0)
  assert.equal(nextTextFileMatch(3, 0, -1), 2)
  assert.equal(nextTextFileMatch(3, -1, -1), 2)
  assert.equal(nextTextFileMatch(3, 99, 1), 0)
  assert.equal(nextTextFileMatch(0, 0, 1), -1)
})

test('very broad queries are bounded and explicitly report the limit', () => {
  const result = findTextFileMatches('x'.repeat(TEXT_SEARCH_MATCH_LIMIT + 5), 'x')
  assert.equal(result.matches.length, TEXT_SEARCH_MATCH_LIMIT)
  assert.equal(result.limited, true)
})
