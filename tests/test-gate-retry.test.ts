import assert from 'node:assert/strict'
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
import { runWithReportFile } from '../scripts/test-run-report.mjs'

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

test('a force-exited runner keeps the results and totals of its test processes', async (t) => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `${name}.test.mjs`)
  const casesPerFile = 400
  const body = `import test from 'node:test'
for (let i = 0; i < ${casesPerFile}; i += 1) test('case ' + i + ' ' + 'x'.repeat(200), () => {})
`
  const repo = repoWith(Object.fromEntries(files.map((file) => [file, body])))
  t.after(repo.cleanup)
  const previous = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  t.after(() => {
    if (previous !== undefined) process.env.NODE_TEST_CONTEXT = previous
  })
  const forwarded: Buffer[] = []
  const blockingStdio = join(process.cwd(), 'scripts/test-blocking-stdio.mjs')
  const run = await runWithReportFile(
    ['--import', blockingStdio, '--test', '--test-force-exit', ...files],
    { cwd: repo.root, onOutput: (chunk: Buffer) => forwarded.push(chunk) }
  )
  const output = Buffer.concat(forwarded).toString()
  assert.equal(run.code, 0)
  assert.equal(hasTestSummary(output), true)
  // A process can still lose its very last line, so allow one per file. Plain stdio loses 9 to 75.
  const reported = output.match(/^✔ case /gm)?.length ?? 0
  assert.ok(reported >= files.length * (casesPerFile - 1), `${reported} results reported`)
})

test('a report file carries the whole output, the totals and the exit code', async (t) => {
  const repo = repoWith({
    'a.test.mjs': `import test from 'node:test'
for (let i = 0; i < 300; i += 1) test('case ' + i + ' 中文', () => {})
test('fails', () => { throw new Error('boom') })
`
  })
  t.after(repo.cleanup)
  const previous = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  t.after(() => {
    if (previous !== undefined) process.env.NODE_TEST_CONTEXT = previous
  })
  const forwarded: Buffer[] = []
  const run = await runWithReportFile(['--test', '--test-force-exit', 'a.test.mjs'], {
    cwd: repo.root,
    onOutput: (chunk: Buffer) => forwarded.push(chunk)
  })
  const output = Buffer.concat(forwarded).toString()
  assert.equal(run.code, 1)
  assert.equal(output.match(/^✔ case \d+ 中文/gm)?.length, 300)
  assert.equal(hasTestSummary(output), true)
  assert.equal(run.tail, output)
})
