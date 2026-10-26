import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateKernelPerfBudget,
  percentileSummary,
  renderKernelPerfMarkdown
} from '../scripts/kernel-perf'
import {
  PeakTreeSampler,
  remoteProcessTree,
  selectRemoteKernelPid
} from '../scripts/kernel-perf/process-tree'

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
    legacy: {
      k0BaselineMb: 628,
      k0Workload: 'small notes fixture; no skills or MCP',
      sameRunFourSessionMb: null,
      sameRunWorkload: '3000 files; skills and MCP',
      sameRunFailure: 'Error: legacy fixture failed exactly here',
      sameRunProcessTree: [],
      sameRunMcpSessionsVerified: 0
    },
    budgets: evaluateKernelPerfBudget({ legacyBaselineMb: 628 }),
    cleanup: { complete: true, remainingProcesses: [] }
  })
  assert.match(markdown, /\| Budget line \| Result \|/u)
  assert.match(markdown, /K0-2 recorded legacy baseline/u)
  assert.match(markdown, /Current kernel/u)
  assert.match(markdown, /legacy fixture failed exactly here/u)
  assert.match(markdown, /not measured/u)
  assert.doesNotMatch(markdown, /not measured[^\n]*PASS/u)
})

test('remote process measurement prefers the PID reported by the kernel runtime', () => {
  assert.equal(selectRemoteKernelPid({ runtimePid: 42, helperPid: 7 }), 42)
  assert.equal(selectRemoteKernelPid({ helperPid: 7 }), 7)
  assert.throws(() => selectRemoteKernelPid({}), /did not report a usable/u)
})

test('remote process tree samples only the connected user and retains root descendants', async () => {
  let command = ''
  const tree = await remoteProcessTree(42, async (value) => {
    command = value
    return {
      code: 0,
      stderr: '',
      stdout: ' 42 1 1024 /tmp/phi-kernel\n 43 42 512 /bin/sh candidate-mcp.sh\n 99 1 2048 other\n'
    }
  })
  assert.match(command, /ps -u "\$\(id -u\)"/u)
  assert.deepEqual(
    tree.map((process) => process.pid),
    [42, 43]
  )
})

test('peak sampler retains the process tree from the peak RSS sample', async () => {
  const samples = [
    [
      { pid: 10, ppid: 1, rssMb: 20, command: 'kernel' },
      { pid: 11, ppid: 10, rssMb: 30, command: 'mcp' }
    ],
    [{ pid: 10, ppid: 1, rssMb: 25, command: 'kernel' }]
  ]
  const sampler = new PeakTreeSampler(() => samples.shift()!, 10)
  await sampler.once()
  await sampler.once()
  assert.equal(sampler.peakMb, 50)
  assert.deepEqual(
    sampler.peakTree.map((process) => process.pid),
    [10, 11]
  )
  assert.deepEqual(
    sampler.latest.map((process) => process.pid),
    [10]
  )
})
