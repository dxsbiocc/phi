import assert from 'node:assert/strict'
import test from 'node:test'
import { diffStat } from '../src/renderer/src/lib/toolOutput'

test('ordinary tool output does not report Markdown list items as deleted diff lines', () => {
  assert.equal(diffStat('- First result\n- Second result'), null)
  assert.equal(diffStat('+ Passed check\n- Skipped check'), null)
})

test('unified diff stats count only changed lines inside complete hunks', () => {
  const output = [
    'diff --git a/example.txt b/example.txt',
    '--- a/example.txt',
    '+++ b/example.txt',
    '@@ -1,2 +1,2 @@',
    ' unchanged',
    '-old',
    '+new',
    '- This is a summary after the diff, not a deletion'
  ].join('\n')

  assert.deepEqual(diffStat(output), { added: 1, removed: 1 })
})
