import assert from 'node:assert/strict'
import test from 'node:test'
import { toolTargetFromArgs } from '../src/renderer/src/lib/toolTargets'

test('toolTargetFromArgs extracts edit and write targets', () => {
  assert.deepEqual(
    toolTargetFromArgs('edit', '{"path":"./src/App.tsx"}', '/Users/example/project'),
    {
      label: './src/App.tsx',
      absolutePath: '/Users/example/project/src/App.tsx'
    }
  )
  assert.deepEqual(
    toolTargetFromArgs('write', '{"file_path":"/Users/example/project/README.md"}', ''),
    {
      label: '/Users/example/project/README.md',
      absolutePath: '/Users/example/project/README.md'
    }
  )
})

test('toolTargetFromArgs ignores non-file tools and invalid paths', () => {
  assert.equal(toolTargetFromArgs('shell', '{"path":"./src/App.tsx"}', '/Users/example'), null)
  assert.equal(toolTargetFromArgs('edit', '{"path":"src/App.tsx"}', '/Users/example'), null)
  assert.equal(toolTargetFromArgs('write', '{bad json', '/Users/example'), null)
})
