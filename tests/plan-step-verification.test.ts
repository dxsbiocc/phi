import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { PlanRunState, PlanSpec } from '../src/shared/planRunTypes'
import { createPlanExecutor } from '../src/main/agent/plan/execution/plan-executor'
import { verifyPlanStepChecks } from '../src/main/agent/plan/execution/step-verification'
import type { StepOutcome, StepRunner } from '../src/main/agent/plan/execution/step-runner'
import { validatePlanSpec } from '../src/main/agent/plan/model/plan-spec'

test('validatePlanSpec enforces closed list of check kinds and rejects path escapes', () => {
  const valid = validatePlanSpec({
    version: 1,
    goal: 'Quantify reads',
    steps: [
      {
        id: 'quant',
        title: 'Run quantification',
        instructions: 'Produce counts.tsv',
        acceptance: 'counts.tsv has gene_id and count columns',
        dependsOn: [],
        access: 'write',
        writes: ['results/counts.tsv'],
        checks: [
          {
            kind: 'table_schema',
            path: 'results/counts.tsv',
            format: 'tsv',
            minDataRows: 1,
            requiredColumns: ['gene_id', 'count']
          }
        ]
      }
    ]
  })
  assert.equal(valid.ok, true)

  const unknownKind = validatePlanSpec({
    version: 1,
    goal: 'Bad check',
    steps: [
      {
        id: 's1',
        title: 'Step 1',
        instructions: 'Do work',
        acceptance: 'Done',
        dependsOn: [],
        access: 'read',
        checks: [{ kind: 'shell_exec', path: 'results/out.txt' }]
      }
    ]
  })
  assert.equal(unknownKind.ok, false)
  if (!unknownKind.ok) {
    assert.match(unknownKind.errors[0], /kind must be one of/)
  }

  const escapePath = validatePlanSpec({
    version: 1,
    goal: 'Escape check',
    steps: [
      {
        id: 's1',
        title: 'Step 1',
        instructions: 'Do work',
        acceptance: 'Done',
        dependsOn: [],
        access: 'read',
        checks: [{ kind: 'file_exists', path: '../secret.txt' }]
      }
    ]
  })
  assert.equal(escapePath.ok, false)
  if (!escapePath.ok) {
    assert.match(escapePath.errors[0], /outside it/)
  }
})

test('PlanExecutor blocks false self-reported completion when objective post-step checks fail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-plan-verify-exec-'))
  try {
    const startedSteps: string[] = []
    let latestState: PlanRunState | undefined
    const spec: PlanSpec = {
      version: 1,
      goal: 'Two-step RNA-seq analysis',
      steps: [
        {
          id: 'step-1',
          title: 'Generate count table',
          instructions: 'Write results/counts.tsv',
          acceptance: 'Non-empty TSV with gene_id and sample_1',
          dependsOn: [],
          access: 'write',
          writes: ['results/counts.tsv'],
          checks: [
            {
              kind: 'table_schema',
              path: 'results/counts.tsv',
              format: 'tsv',
              minDataRows: 1,
              requiredColumns: ['gene_id', 'sample_1']
            }
          ]
        },
        {
          id: 'step-2',
          title: 'Run DE analysis',
          instructions: 'Analyze results/counts.tsv',
          acceptance: 'DE table written',
          dependsOn: ['step-1'],
          access: 'write',
          writes: ['results/de.tsv']
        }
      ]
    }

    const runner: StepRunner = {
      async start(params) {
        const match = /Step:\s+([a-z0-9-]+)/i.exec(params.task)
        startedSteps.push(match?.[1] ?? 'unknown')
        const outcome: StepOutcome = {
          ok: true,
          report: {
            status: 'completed',
            text: 'I finished generating counts.tsv!',
            missingInputs: [],
            structured: true
          }
        }
        return { runId: `agent-${startedSteps.length}`, done: Promise.resolve(outcome) }
      },
      stop: async () => undefined
    }

    const executor = createPlanExecutor({
      runner,
      store: {
        write: (state) => {
          latestState = state
        }
      },
      events: { emit: () => {} },
      clock: () => '2026-11-23T00:00:00.000Z',
      ids: () => 'prun_1',
      verifyStep: ({ step }) => verifyPlanStepChecks(step, dir)
    })

    // Step 1 lies and does not create results/counts.tsv: retries once then pauses, never launching step-2.
    await executor.start(spec, 'sess_1')
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(latestState?.status, 'paused')
    assert.equal(latestState?.steps['step-1']?.status, 'failed')
    assert.match(latestState?.steps['step-1']?.error ?? '', /Post-step verification failed/)
    assert.equal(latestState?.steps['step-2']?.status, 'pending')
    assert.equal(startedSteps.filter((id) => id === 'step-2').length, 0)

    // Now write the valid output file and retry step-1: both step-1 and step-2 succeed.
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeFileSync(join(dir, 'results', 'counts.tsv'), 'gene_id\tsample_1\nENSG1\t100\n')
    await executor.retryStep('prun_1', 'step-1')
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(latestState?.steps['step-1']?.status, 'done')
    assert.equal(latestState?.steps['step-2']?.status, 'done')
    assert.equal(latestState?.status, 'completed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
