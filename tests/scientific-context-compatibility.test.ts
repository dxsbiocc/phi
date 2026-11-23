import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { PlanRunState, PlanSpec } from '../src/shared/planRunTypes'
import { observedValue } from '../src/shared/scientificContextTypes'
import { createPlanExecutor } from '../src/main/agent/plan/execution/plan-executor'
import type { StepRunner } from '../src/main/agent/plan/execution/step-runner'
import { evaluateStepScientificCompatibility } from '../src/main/agent/scientific-context/compatibility'
import { writeScientificContextSidecar } from '../src/main/agent/scientific-context/sidecar'

function makeSpec(): PlanSpec {
  return {
    version: 1,
    goal: 'Run donor-paired DESeq2',
    steps: [
      {
        id: 'deseq2',
        title: 'Run DESeq2 on raw gene counts',
        instructions: 'Fit ~ donor + condition',
        acceptance: 'DE results written',
        dependsOn: [],
        access: 'write',
        writes: ['results/de.tsv'],
        inputContracts: [
          {
            path: 'results/counts.tsv',
            expectedReferenceAssembly: 'GRCh38.p14',
            requiredMatrixSemantics: ['raw_counts'],
            requireDonorMapping: true
          }
        ]
      }
    ]
  }
}

test('R14 preflight pauses with needs_input when upstream scientific metadata is unknown, with 0 launches and 0 attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-r14-unknown-'))
  try {
    mkdirSync(join(dir, 'results'), { recursive: true })
    // Legacy counts file with NO sidecar -> all metadata unknown.
    writeFileSync(join(dir, 'results', 'counts.tsv'), 'gene_id\tS1\nG1\t10\n')

    let runnerStartCalls = 0
    let latestState: PlanRunState | undefined
    const runner: StepRunner = {
      async start() {
        runnerStartCalls += 1
        return {
          runId: 'should-not-run',
          done: Promise.resolve({
            ok: true,
            report: { status: 'completed', text: 'ok', missingInputs: [] }
          })
        }
      },
      async stop() {}
    }

    const executor = createPlanExecutor({
      runner,
      store: { write: (s) => { latestState = s } },
      events: { emit: () => {} },
      clock: () => '2026-11-23T01:00:00.000Z',
      ids: () => 'prun_r14_1',
      preflightStep: ({ step }) => evaluateStepScientificCompatibility(step, dir)
    })

    await executor.start(makeSpec(), 'sess_1')
    assert.equal(runnerStartCalls, 0, 'preflight must block BEFORE runner.start()')
    assert.equal(latestState?.status, 'paused')
    assert.equal(latestState?.pause?.reason, 'needs_input')
    assert.equal(latestState?.steps.deseq2?.attempts, 0)
    assert.equal(latestState?.steps.deseq2?.agentRunId, undefined)
    assert.ok((latestState?.steps.deseq2?.report?.missingInputs.length ?? 0) > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R14 preflight pauses with step_failed (no retry) when log_transformed matrix is passed to DESeq2, and passes once fixed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-r14-incompat-'))
  try {
    mkdirSync(join(dir, 'results'), { recursive: true })
    const countsPath = join(dir, 'results', 'counts.tsv')
    writeFileSync(countsPath, 'gene_id\tS1\tS2\nG1\t3.2\t4.1\n')
    writeScientificContextSidecar(countsPath, {
      producer: { kind: 'notebook', id: 'norm.ipynb' },
      location: 'local',
      path: countsPath,
      hashLocalBytes: true,
      reference: observedValue({ assembly: 'GRCm39' }, 'star:index'),
      samples: observedValue({ sampleIds: ['S1', 'S2'], donorBySample: { S1: 'D1', S2: 'D2' } }, 'meta'),
      matrix: observedValue({ valueSemantics: 'log_transformed' }, 'notebook')
    })

    let runnerStartCalls = 0
    let latestState: PlanRunState | undefined
    const runner: StepRunner = {
      async start() {
        runnerStartCalls += 1
        return {
          runId: `agent-${runnerStartCalls}`,
          done: Promise.resolve({
            ok: true,
            report: { status: 'completed', text: 'DE done', missingInputs: [] }
          })
        }
      },
      async stop() {}
    }

    const executor = createPlanExecutor({
      runner,
      store: { write: (s) => { latestState = s } },
      events: { emit: () => {} },
      clock: () => '2026-11-23T01:00:00.000Z',
      ids: () => 'prun_r14_2',
      preflightStep: ({ step }) => evaluateStepScientificCompatibility(step, dir)
    })

    await executor.start(makeSpec(), 'sess_1')
    assert.equal(runnerStartCalls, 0)
    assert.equal(latestState?.status, 'paused')
    assert.equal(latestState?.pause?.reason, 'step_failed')
    assert.equal(latestState?.steps.deseq2?.attempts, 0)
    assert.match(latestState?.steps.deseq2?.error ?? '', /Matrix semantics mismatch/)
    assert.match(latestState?.steps.deseq2?.error ?? '', /Reference assembly mismatch/)

    // Now supply compatible raw_counts + GRCh38.p14 sidecar and retry -> succeeds!
    writeScientificContextSidecar(countsPath, {
      producer: { kind: 'wrapper', id: 'nf-core/modules/salmon' },
      location: 'local',
      path: countsPath,
      hashLocalBytes: true,
      reference: observedValue({ assembly: 'GRCh38.p14' }, 'salmon:index'),
      samples: observedValue({ sampleIds: ['S1', 'S2'], donorBySample: { S1: 'D1', S2: 'D2' } }, 'meta'),
      matrix: observedValue({ valueSemantics: 'raw_counts' }, 'salmon:tximport')
    })

    await executor.retryStep('prun_r14_2', 'deseq2')
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(runnerStartCalls, 1)
    assert.equal(latestState?.status, 'completed')
    assert.equal(latestState?.steps.deseq2?.status, 'done')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
