import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parse } from 'yaml'

type Step = { name?: string; run?: string; with?: Record<string, string> }

const workflow = parse(readFileSync('.github/workflows/content.yml', 'utf8')) as {
  jobs: {
    core: {
      steps: Step[]
      strategy: { 'fail-fast': boolean; matrix: { shard: number[] } }
    }
  }
}
const steps = workflow.jobs.core.steps
const indexOfRun = (fragment: string): number =>
  steps.findIndex((step) => step.run?.includes(fragment))

test('independent core runs the gate after preparing what its suites need', () => {
  const gate = indexOfRun('bun run test:gate')
  assert.notEqual(gate, -1)
  for (const prerequisite of [
    'bun install --frozen-lockfile',
    'node node_modules/electron/install.js',
    'bun run build:helper',
    'ripgrep zsh csh'
  ]) {
    const index = indexOfRun(prerequisite)
    assert.notEqual(index, -1, prerequisite)
    assert.ok(index < gate, `${prerequisite} must run before the gate`)
  }
})

test('independent core runs every shard it declares on every OS', () => {
  const { strategy } = workflow.jobs.core
  const gate = steps[indexOfRun('bun run test:gate')].run
  assert.equal(gate, 'bun run test:gate --shard=${{ matrix.shard }}/4')
  assert.deepEqual(strategy.matrix.shard, [1, 2, 3, 4])
  assert.equal(strategy['fail-fast'], false)
})

test('independent core runs on the Node line Electron bundles', () => {
  const electron = JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')) as {
    version: string
  }
  assert.equal(Number(electron.version.split('.')[0]), 44)
  const node = steps.find((step) => step.name === 'Setup Node')
  assert.equal(node?.with?.['node-version'], '24')
})
