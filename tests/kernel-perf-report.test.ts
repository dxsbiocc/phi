import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateKernelPerfBudget,
  percentileSummary,
  renderKernelPerfMarkdown
} from '../scripts/kernel-perf'

test('performance budget never passes an unmeasured line and applies both memory gates', () => {
  const missing = evaluateKernelPerfBudget({ legacyBaselineMb: 628 })
  assert.deepEqual(
    missing.map((line) => line.status),
    ['not measured', 'not measured', 'not measured', 'not measured', 'not measured']
  )

  const measured = evaluateKernelPerfBudget({
    localReadyP95Ms: 900,
    fourSessionPeakMb: 950,
    legacyBaselineMb: 628,
    sameRunLegacyFourSessionMb: 640
  })
  assert.deepEqual(
    measured.map((line) => line.status),
    ['PASS', 'FAIL', 'PASS', 'PASS', 'PASS']
  )

  const hardFailure = evaluateKernelPerfBudget({
    localReadyP95Ms: 1_001,
    fourSessionPeakMb: 1_537,
    legacyBaselineMb: 628
  })
  assert.equal(hardFailure[0].status, 'FAIL')
  assert.equal(hardFailure[2].status, 'FAIL')
  assert.equal(hardFailure[3].status, 'FAIL')
})

test('performance report renders nearest-rank percentiles and explicit missing evidence', () => {
  assert.deepEqual(percentileSummary([40, 10, 30, 20]), { n: 4, p50: 20, p95: 40, max: 40 })
  const markdown = renderKernelPerfMarkdown({
    schemaVersion: 1,
    candidateId: 'abc1234',
    target: 'local',
    measuredAt: '2026-10-27T00:00:00.000Z',
    machine: { os: 'darwin', arch: 'arm64', node: 'v24', bun: '1.3.3' },
    versions: { phi: '0.1.0', omp: '18.10.3', native: '18.10.3' },
    project: { files: 3000, skills: true, stdioMcpPerSession: true },
    ready: null,
    workloads: [],
    legacy: { k0BaselineMb: 628, sameRunFourSessionMb: null },
    budgets: evaluateKernelPerfBudget({ legacyBaselineMb: 628 }),
    cleanup: { complete: true, remainingProcesses: [] }
  })
  assert.match(markdown, /\| Budget line \| Result \|/u)
  assert.match(markdown, /not measured/u)
  assert.doesNotMatch(markdown, /not measured[^\n]*PASS/u)
})
