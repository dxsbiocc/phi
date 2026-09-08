import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveLocalPath, tokenizeLocalPaths } from '../src/renderer/src/lib/localPaths'

test('local path tokens resolve explicit relative paths against cwd', () => {
  assert.equal(
    resolveLocalPath('./src/App.tsx', '/Users/example/project'),
    '/Users/example/project/src/App.tsx'
  )
  assert.equal(
    resolveLocalPath('../README.md', '/Users/example/project/src'),
    '/Users/example/project/README.md'
  )
})

test('local path tokens preserve trailing punctuation as text', () => {
  const tokens = tokenizeLocalPaths('Open ./src/App.tsx, then continue.', '/Users/example/project')

  assert.deepEqual(tokens, [
    { kind: 'text', text: 'Open ' },
    {
      kind: 'path',
      text: './src/App.tsx',
      absolutePath: '/Users/example/project/src/App.tsx'
    },
    { kind: 'text', text: ',' },
    { kind: 'text', text: ' then continue.' }
  ])
})

test('local path tokens ignore non-explicit relative words', () => {
  assert.deepEqual(tokenizeLocalPaths('Open src/App.tsx', '/Users/example/project'), [
    { kind: 'text', text: 'Open src/App.tsx' }
  ])
})
