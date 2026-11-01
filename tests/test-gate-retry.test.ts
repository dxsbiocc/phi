import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { failureLocations, suitesForFailures } from '../scripts/test-affected.mjs'

function repoWith(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'phi-test-gate-retry-'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('failure locations come from the report, whatever the path looks like', () => {
  const output = [
    '✖ failing tests:',
    '',
    'test at tests/a.test.ts:27:1',
    '✖ first (10ms)',
    '      at Timeout (file:///repo/tests/helpers/frame.ts:9:1)',
    '',
    'test at file:///repo/tests/nested/b.test.ts:198:1',
    '✖ second (10ms)',
    '',
    'test at src/outside.ts:3:1',
    '✖ third (10ms)'
  ].join('\n')
  assert.deepEqual(failureLocations(output), [
    'tests/a.test.ts',
    'tests/nested/b.test.ts',
    'src/outside.ts'
  ])
})

test('a body loaded through a bare import, or through a helper, maps to the suite that runs it', (t) => {
  const repo = repoWith({
    'tests/runner.test.ts': "import './nested/body.test'\n",
    'tests/nested/body.test.ts': "import { shared } from './shared'\nshared()\n",
    'tests/nested/shared.ts': 'export const shared = (): void => {}\n',
    'tests/other.test.ts': 'export {}\n'
  })
  t.after(repo.cleanup)
  const selected = ['tests/other.test.ts', 'tests/runner.test.ts']
  for (const failed of ['tests/nested/body.test.ts', 'tests/nested/shared.ts']) {
    assert.deepEqual(suitesForFailures(repo.root, [failed], selected), {
      suites: ['tests/runner.test.ts'],
      unowned: []
    })
  }
})

test('a failure in a selected suite retries only that suite', (t) => {
  const repo = repoWith({ 'tests/a.test.ts': '', 'tests/b.test.ts': '' })
  t.after(repo.cleanup)
  assert.deepEqual(
    suitesForFailures(repo.root, ['tests/a.test.ts'], ['tests/a.test.ts', 'tests/b.test.ts']),
    { suites: ['tests/a.test.ts'], unowned: [] }
  )
})

test('a failure no selected suite reaches is reported, so it cannot pass on the others', (t) => {
  const repo = repoWith({ 'tests/a.test.ts': '', 'tests/stray.ts': '' })
  t.after(repo.cleanup)
  assert.deepEqual(
    suitesForFailures(repo.root, ['tests/a.test.ts', 'tests/stray.ts'], ['tests/a.test.ts']),
    { suites: ['tests/a.test.ts'], unowned: ['tests/stray.ts'] }
  )
})
