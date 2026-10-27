import assert from 'node:assert/strict'
import test from 'node:test'

import { candidateEvidenceSteps } from '../scripts/kernel-candidate-evidence'

test('candidate evidence plan preserves the required gate, build, focused-test, and perf order', () => {
  const steps = candidateEvidenceSteps({
    candidateId: 'abc1234',
    candidateDirectory: '/evidence/abc1234',
    phiVersion: '0.1.0'
  })
  assert.deepEqual(
    steps.map((step) => step.name),
    [
      'typecheck',
      'typecheck-tests',
      'lint',
      'engine-boundary',
      'main-boundary',
      'architecture-boundary',
      'test-gate',
      'build-kernel-darwin-arm64',
      'build-kernel-linux-x64',
      'build-app',
      'main-bundle-runtime',
      'a19-rollback-a17-tests',
      'package-check',
      'kernel-perf-local'
    ]
  )
  assert.deepEqual(steps[6].command, ['node', 'scripts/test-gate.mjs'])
  assert.deepEqual(steps[7].command, ['bun', 'scripts/build-kernel.ts', '--target', 'darwin-arm64'])
  assert.deepEqual(steps[9].command, ['bun', 'run', 'build'])
  assert.deepEqual(steps[10].command, ['bun', 'run', 'check:main-bundle-runtime'])
  assert.match(steps[11].command.join(' '), /kernel-candidate-history\.test\.ts/u)
  assert.match(steps[11].command.join(' '), /kernel-local-package\.test\.ts/u)
  assert.match(steps[13].command.join(' '), /--candidate abc1234/u)
})
