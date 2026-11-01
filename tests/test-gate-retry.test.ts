import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  failureLocations,
  hasTestSummary,
  SERIAL_SUITES,
  splitSerialSuites,
  suitesForFailures
} from '../scripts/test-affected.mjs'

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

test('every serial suite exists, and each suite runs in exactly one lane', () => {
  for (const suite of SERIAL_SUITES) assert.ok(existsSync(suite), suite)
  const [serial] = SERIAL_SUITES
  assert.deepEqual(splitSerialSuites(['tests/light.test.ts', serial]), {
    parallel: ['tests/light.test.ts'],
    serial: [serial]
  })
})

test('only a report with totals counts as a finished run', () => {
  assert.equal(hasTestSummary('✔ one (1ms)\nℹ tests 1\nℹ pass 1\n'), true)
  assert.equal(hasTestSummary('✔ one (1ms)\n✔ two (1ms)\n'), false)
})

test('a slow reader still receives the whole report from a force-exited runner', async (t) => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `${name}.test.mjs`)
  const casesPerFile = 400
  const body = `import test from 'node:test'
for (let i = 0; i < ${casesPerFile}; i += 1) test('case ' + i + ' ' + 'x'.repeat(200), () => {})
`
  const repo = repoWith(Object.fromEntries(files.map((file) => [file, body])))
  t.after(repo.cleanup)
  // The reader starts late so the pipe fills up, which is what a busy gate does to the runner.
  const blockingStdio = join(process.cwd(), 'scripts/test-blocking-stdio.mjs')
  const child = spawn(
    'sh',
    [
      '-c',
      'node="$1"; blocking="$2"; shift 2; "$node" --import "$blocking" --test --test-force-exit "$@" 2>/dev/null | (sleep 2; cat)',
      'sh',
      process.execPath,
      blockingStdio,
      ...files.map((file) => join(repo.root, file))
    ],
    {
      // Inherited, this would make the inner runner report to us in its binary format.
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      stdio: ['ignore', 'pipe', 'ignore']
    }
  )
  let output = ''
  child.stdout.on('data', (chunk) => (output += String(chunk)))
  await new Promise((resolve) => child.once('close', resolve))
  assert.equal(output.match(/^✔ case /gm)?.length, files.length * casesPerFile)
  assert.equal(hasTestSummary(output), true)
})
