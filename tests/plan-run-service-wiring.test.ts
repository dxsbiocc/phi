import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { AgentRunCompletion } from '../src/main/agent/plan/execution/agent-run-completions'
import { createPlanRunService } from '../src/main/agent/plan/plan-run-service'
import { writeScientificContextSidecar } from '../src/main/agent/scientific-context/sidecar'
import type { PlanRunState, PlanSpec } from '../src/shared/planRunTypes'

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail('Timed out waiting for plan execution')
}

test('PlanRunService wires objective post-step checks when resolveProjectRoot is provided', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'phi-plan-wiring-'))
  try {
    mkdirSync(join(projectRoot, 'results'), { recursive: true })
    const spec: PlanSpec = {
      version: 1,
      goal: 'Produce validated summary table',
      steps: [
        {
          id: 'step-check',
          title: 'Write table',
          instructions: 'Write results/summary.tsv',
          acceptance: 'Summary table exists and has required columns',
          dependsOn: [],
          access: 'write',
          checks: [
            {
              kind: 'table_schema',
              path: 'results/summary.tsv',
              format: 'tsv',
              minDataRows: 1,
              requiredColumns: ['gene_id', 'log2FoldChange']
            }
          ]
        }
      ]
    }
    const states = new Map<string, PlanRunState>()
    const waiters: Array<{ runId: string; resolve: (value: AgentRunCompletion) => void }> = []
    let runSeq = 0
    const service = createPlanRunService({
      engine: {
        agentRuns: {
          start: async () => ({ runId: `agent-${++runSeq}` }),
          stop: async () => undefined
        }
      },
      completions: {
        expect: (_runtimeSessionId, runId) =>
          new Promise((resolve) => {
            waiters.push({ runId, resolve })
          }),
        deliver: () => false,
        abandonSession: () => undefined
      },
      resolveRuntimeSessionId: () => 'runtime-1',
      resolveProjectRoot: () => projectRoot,
      store: {
        write: (state) => {
          states.set(state.id, state)
        },
        read: (_sessionId, runId) => states.get(runId) ?? null,
        list: () => [...states.values()],
        listUnfinished: () => []
      },
      timeline: { append: (_sessionId, event) => event, broadcast: () => undefined },
      continueConversation: () => undefined,
      logError: (error) => assert.fail(String(error)),
      clock: () => '2026-11-23T00:00:00.000Z',
      ids: () => 'plan-verify'
    })

    await service.startFromApprovedPlan('phi-1', spec)
    await until(() => waiters.length === 1)
    // Attempt 1 finishes without creating results/summary.tsv -> fails check & auto-retries.
    waiters.shift()!.resolve({
      id: 'agent-1',
      state: 'done',
      origin: 'host',
      report: 'Finished writing table'
    })
    await until(() => waiters.length === 1)
    // Attempt 2 also finishes without creating results/summary.tsv -> plan pauses on step_failed.
    waiters.shift()!.resolve({
      id: 'agent-2',
      state: 'done',
      origin: 'host',
      report: 'Finished writing table again'
    })
    await until(() => states.get('plan-verify')?.status === 'paused')

    const failedState = states.get('plan-verify')!
    assert.equal(failedState.steps['step-check']?.status, 'failed')
    assert.match(failedState.steps['step-check']?.error ?? '', /Post-step verification failed/u)

    // Create valid table and retry -> must pass objective verification and complete the plan.
    writeFileSync(
      join(projectRoot, 'results/summary.tsv'),
      'gene_id\tlog2FoldChange\nG1\t1.5\n',
      'utf8'
    )
    await service.retryStep('phi-1', 'plan-verify', 'step-check')
    await until(() => waiters.length === 1)
    const retryWaiter = waiters.shift()!
    retryWaiter.resolve({
      id: retryWaiter.runId,
      state: 'done',
      origin: 'host',
      report: 'Verified table'
    })
    await until(() => states.get('plan-verify')?.status === 'completed')
    assert.equal(states.get('plan-verify')?.steps['step-check']?.status, 'done')
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('PlanRunService wires cross-step scientific compatibility preflight before step launch', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'phi-plan-preflight-'))
  try {
    const matrixPath = join(projectRoot, 'counts.tsv')
    writeFileSync(matrixPath, 'gene\tS1\nG1\t4.2\n', 'utf8')
    writeScientificContextSidecar(matrixPath, {
      producer: { kind: 'plan_step', id: 'step-upstream' },
      location: 'local',
      path: matrixPath,
      matrix: {
        status: 'observed',
        value: { valueSemantics: 'log_transformed', featureIdType: 'ensembl_gene' },
        source: 'test-sidecar'
      }
    })

    const spec: PlanSpec = {
      version: 1,
      goal: 'Run differential expression on count matrix',
      steps: [
        {
          id: 'step-de',
          title: 'Differential expression',
          instructions: 'Run DE model on counts.tsv',
          acceptance: 'DE results written',
          dependsOn: [],
          access: 'write',
          inputContracts: [
            {
              path: 'counts.tsv',
              requiredMatrixSemantics: ['raw_counts']
            }
          ]
        }
      ]
    }

    let launched = 0
    const states = new Map<string, PlanRunState>()
    const service = createPlanRunService({
      engine: {
        agentRuns: {
          start: async () => {
            launched += 1
            return { runId: 'agent-unexpected' }
          },
          stop: async () => undefined
        }
      },
      resolveRuntimeSessionId: () => 'runtime-1',
      resolveProjectRoot: () => projectRoot,
      store: {
        write: (state) => {
          states.set(state.id, state)
        },
        read: (_sessionId, runId) => states.get(runId) ?? null,
        list: () => [...states.values()],
        listUnfinished: () => []
      },
      timeline: { append: (_sessionId, event) => event, broadcast: () => undefined },
      continueConversation: () => undefined,
      logError: (error) => assert.fail(String(error)),
      clock: () => '2026-11-23T00:00:00.000Z',
      ids: () => 'plan-preflight'
    })

    const started = await service.startFromApprovedPlan('phi-1', spec)
    assert.equal(launched, 0)
    assert.equal(started.status, 'paused')
    assert.equal(started.steps['step-de']?.status, 'failed')
    assert.match(started.steps['step-de']?.error ?? '', /Cross-step scientific incompatibility/u)
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})
