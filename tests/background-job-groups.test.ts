import assert from 'node:assert/strict'
import test from 'node:test'

import { parseWrapperWorkflow } from '../src/main/agent/wrappers/composition/workflow-identity'
import {
  groupBackgroundJobs,
  workflowStepCounts
} from '../src/renderer/src/features/jobs/lib/backgroundJobGroups'
import {
  newlyObservedJobs,
  workflowPhase
} from '../src/renderer/src/features/jobs/hooks/useBackgroundJobArrivals'
import type { UnifiedBackgroundJob } from '../src/renderer/src/features/jobs/lib/backgroundJobs'
import type { WrapperRun } from '../src/shared/wrapperTypes'

function run(runId: string, state: WrapperRun['state'], workflowId?: string): WrapperRun {
  return {
    runId,
    state,
    createdAt: `2026-10-23T00:0${runId.slice(-1)}:00.000Z`,
    updatedAt: `2026-10-23T00:0${runId.slice(-1)}:00.000Z`,
    executor: 'slurm',
    wrapper: { canonicalId: 'phi/rna/fastp', shortId: 'fastp', namespace: 'phi/rna', version: '1' },
    ...(workflowId
      ? { workflow: { id: workflowId, name: 'RNA-seq', step: 'Trimming', totalSteps: 4 } }
      : {})
  } as WrapperRun
}

type WrapperJob = Extract<UnifiedBackgroundJob, { kind: 'wrapper' }>

function workflowAttempt(options: {
  runId: string
  state: WrapperRun['state']
  step?: string
  createdAt: string
  totalSteps?: number | null
  active?: boolean
  workflowId?: string
}): WrapperJob {
  const base = run(options.runId, options.state, options.workflowId ?? 'rna')
  const workflow = base.workflow!
  const totalSteps = options.totalSteps === undefined ? 4 : options.totalSteps
  return {
    kind: 'wrapper',
    key: `wrapper:${options.runId}`,
    active: options.active ?? false,
    timestamp: options.createdAt,
    run: {
      ...base,
      createdAt: options.createdAt,
      updatedAt: options.createdAt,
      workflow: {
        id: workflow.id,
        name: workflow.name,
        ...(options.step ? { step: options.step } : {}),
        ...(totalSteps === null ? {} : { totalSteps })
      }
    }
  }
}

test('only explicit workflow membership joins Wrapper runs and counts one active parent', () => {
  const jobs = [
    {
      kind: 'wrapper' as const,
      key: 'wrapper:wrun_1',
      active: false,
      timestamp: '2026-10-23T00:01:00.000Z',
      run: run('wrun_1', 'completed', 'session:rna')
    },
    {
      kind: 'wrapper' as const,
      key: 'wrapper:wrun_2',
      active: true,
      timestamp: '2026-10-23T00:02:00.000Z',
      run: run('wrun_2', 'running', 'session:rna')
    },
    {
      kind: 'wrapper' as const,
      key: 'wrapper:wrun_3',
      active: true,
      timestamp: '2026-10-23T00:03:00.000Z',
      run: run('wrun_3', 'running')
    }
  ]
  const display = groupBackgroundJobs(jobs)
  assert.equal(display.length, 2)
  const workflow = display.find((item) => item.kind === 'workflow')
  assert.equal(workflow?.key, 'workflow:session:rna')
  assert.equal(workflow?.active, true)
  assert.equal(workflow?.expectedSteps, 4)
  assert.deepEqual(
    workflow?.jobs.map((item) => item.run.runId),
    ['wrun_1', 'wrun_2']
  )
  assert.equal(display.find((item) => item.kind === 'job')?.key, 'wrapper:wrun_3')
})

test('workflow metadata is bounded and cannot use arbitrary ids or missing names', () => {
  assert.deepEqual(parseWrapperWorkflow({ id: 'rna_1', name: 'RNA-seq', totalSteps: 4 }), {
    id: 'rna_1',
    name: 'RNA-seq',
    totalSteps: 4
  })
  assert.equal(parseWrapperWorkflow({ id: '../rna', name: 'RNA-seq' }), undefined)
  assert.equal(parseWrapperWorkflow({ id: 'rna', name: '' }), undefined)
  assert.equal(parseWrapperWorkflow({ id: 'rna', name: 'RNA-seq\nspoofed' }), undefined)
  assert.equal(parseWrapperWorkflow({ id: 'rna', name: 'RNA-seq', totalSteps: 0 }), undefined)
})

test('additional Wrapper steps reuse one notice identity and only finish at the expected count', () => {
  const attempts = ['QC', 'Alignment', 'Quantification', 'Report'].map((step, index) =>
    workflowAttempt({
      runId: `wrun_${index + 1}`,
      state: 'completed',
      step,
      createdAt: `2026-10-23T00:0${index + 1}:00.000Z`
    })
  )
  const first = attempts[0]
  const firstDisplay = groupBackgroundJobs([first])
  const known = new Set(firstDisplay.map((item) => item.key))
  assert.equal(workflowPhase(firstDisplay[0]), 'running')

  const finalDisplay = groupBackgroundJobs(attempts)
  assert.deepEqual(newlyObservedJobs(finalDisplay, known), [])
  assert.equal(workflowPhase(finalDisplay[0]), 'completed')
  assert.equal(
    workflowPhase(groupBackgroundJobs([{ ...first, run: { ...first.run, state: 'failed' } }])[0]),
    'failed'
  )
})

test('a retried or repeated step counts once, by its latest attempt', () => {
  const attempts: Array<[string, string, WrapperRun['state']]> = [
    ['wrun_1', 'fastqc', 'completed'],
    ['wrun_2', 'fastp', 'completed'],
    ['wrun_3', 'fastp', 'completed'],
    ['wrun_4', 'salmon-index', 'completed'],
    ['wrun_5', 'salmon-quant', 'failed'],
    ['wrun_6', 'salmon-quant', 'completed']
  ]
  const jobs = attempts.map(([runId, step, state]) => {
    const base = run(runId, state, 'session:rna')
    return {
      kind: 'wrapper' as const,
      key: `wrapper:${runId}`,
      active: false,
      timestamp: base.createdAt,
      run: { ...base, workflow: { ...base.workflow!, step } }
    }
  })
  assert.deepEqual(workflowStepCounts(jobs), { completed: 4, failed: 0 })
})

test('a retried failed step stays active until the expected missing steps arrive', () => {
  const attempts = [
    workflowAttempt({
      runId: 'wrun_qc_failed',
      state: 'failed',
      step: 'QC',
      createdAt: '2026-10-23T00:01:00.000Z'
    }),
    workflowAttempt({
      runId: 'wrun_qc_retry',
      state: 'completed',
      step: 'QC',
      createdAt: '2026-10-23T00:02:00.000Z'
    }),
    workflowAttempt({
      runId: 'wrun_align',
      state: 'completed',
      step: 'Alignment',
      createdAt: '2026-10-23T00:03:00.000Z'
    })
  ]
  const [workflow] = groupBackgroundJobs([...attempts].reverse())
  assert.equal(workflow?.kind, 'workflow')
  if (workflow?.kind !== 'workflow') return
  assert.equal(workflow.active, true)
  assert.equal(workflow.expectedSteps, 4)
  assert.equal(workflow.totalSteps, 4)
  assert.equal(workflowPhase(workflow), 'running')
  assert.deepEqual(workflowStepCounts(workflow.jobs), { completed: 2, failed: 0 })
})

test('superseded failures do not fail or disconnect a completed workflow', () => {
  const attempts = [
    workflowAttempt({
      runId: 'wrun_qc_failed',
      state: 'failed',
      step: 'QC',
      createdAt: '2026-10-23T00:01:00.000Z'
    }),
    workflowAttempt({
      runId: 'wrun_qc_retry',
      state: 'completed',
      step: 'QC',
      createdAt: '2026-10-23T00:02:00.000Z'
    }),
    workflowAttempt({
      runId: 'wrun_align',
      state: 'completed',
      step: 'Alignment',
      createdAt: '2026-10-23T00:03:00.000Z'
    }),
    workflowAttempt({
      runId: 'wrun_quant',
      state: 'completed',
      step: 'Quantification',
      createdAt: '2026-10-23T00:04:00.000Z'
    }),
    workflowAttempt({
      runId: 'wrun_report',
      state: 'completed',
      step: 'Report',
      createdAt: '2026-10-23T00:05:00.000Z'
    })
  ]
  const [workflow] = groupBackgroundJobs(attempts)
  assert.equal(workflow?.kind, 'workflow')
  if (workflow?.kind !== 'workflow') return
  assert.equal(workflow.active, false)
  assert.equal(workflow.totalSteps, 4)
  assert.equal(workflowPhase(workflow), 'completed')
  assert.deepEqual(workflowStepCounts(workflow.jobs), { completed: 4, failed: 0 })
})

test('repeated completed attempts count once and cannot fill expected steps', () => {
  const repeated = Array.from({ length: 4 }, (_, index) =>
    workflowAttempt({
      runId: `wrun_repeat_${index + 1}`,
      state: 'completed',
      step: 'QC',
      createdAt: `2026-10-23T00:0${index + 1}:00.000Z`
    })
  )
  const [withExpected] = groupBackgroundJobs(repeated)
  assert.equal(withExpected?.kind, 'workflow')
  if (withExpected?.kind !== 'workflow') return
  assert.equal(withExpected.expectedSteps, 4)
  assert.equal(withExpected.totalSteps, 4)
  assert.equal(withExpected.active, true)
  assert.equal(workflowPhase(withExpected), 'running')
  assert.deepEqual(workflowStepCounts(withExpected.jobs), { completed: 1, failed: 0 })

  const [withoutExpected] = groupBackgroundJobs(
    repeated.map((job) => ({
      ...job,
      run: {
        ...job.run,
        workflow: { id: job.run.workflow!.id, name: job.run.workflow!.name, step: 'QC' }
      }
    }))
  )
  assert.equal(withoutExpected?.kind, 'workflow')
  if (withoutExpected?.kind !== 'workflow') return
  assert.equal(withoutExpected.expectedSteps, undefined)
  assert.equal(withoutExpected.totalSteps, 1)
  assert.equal(withoutExpected.active, false)
  assert.equal(workflowPhase(withoutExpected), 'running')
  assert.deepEqual(workflowStepCounts(withoutExpected.jobs), { completed: 1, failed: 0 })
})

test('workflows without expected steps never announce completion from visible steps alone', () => {
  const [workflow] = groupBackgroundJobs([
    workflowAttempt({
      runId: 'wrun_visible_qc',
      state: 'completed',
      step: 'QC',
      createdAt: '2026-10-23T00:01:00.000Z',
      totalSteps: null
    }),
    workflowAttempt({
      runId: 'wrun_visible_align',
      state: 'completed',
      step: 'Alignment',
      createdAt: '2026-10-23T00:02:00.000Z',
      totalSteps: null
    })
  ])
  assert.equal(workflow?.kind, 'workflow')
  if (workflow?.kind !== 'workflow') return
  assert.equal(workflow.totalSteps, 2)
  assert.equal(workflow.active, false)
  assert.equal(workflowPhase(workflow), 'running')
})

test('only a latest failed or lost step ends a workflow with a failed notice', () => {
  for (const state of ['failed', 'lost'] as const) {
    const attempts = [
      workflowAttempt({
        runId: `wrun_old_${state}`,
        state: 'completed',
        step: 'QC',
        createdAt: '2026-10-23T00:01:00.000Z'
      }),
      workflowAttempt({
        runId: `wrun_latest_${state}`,
        state,
        step: 'QC',
        createdAt: '2026-10-23T00:02:00.000Z'
      })
    ]
    const [workflow] = groupBackgroundJobs(attempts)
    assert.equal(workflow?.kind, 'workflow')
    if (workflow?.kind !== 'workflow') return
    assert.equal(workflow.active, false, state)
    assert.equal(workflowPhase(workflow), 'failed', state)
  }

  const [cancelledWorkflow] = groupBackgroundJobs([
    workflowAttempt({
      runId: 'wrun_old_cancelled',
      state: 'completed',
      step: 'QC',
      createdAt: '2026-10-23T00:01:00.000Z'
    }),
    workflowAttempt({
      runId: 'wrun_latest_cancelled',
      state: 'cancelled',
      step: 'QC',
      createdAt: '2026-10-23T00:02:00.000Z'
    })
  ])
  assert.equal(cancelledWorkflow?.kind, 'workflow')
  if (cancelledWorkflow?.kind !== 'workflow') return
  assert.equal(cancelledWorkflow.active, false)
  assert.equal(workflowPhase(cancelledWorkflow), 'running')

  const [activeWorkflow] = groupBackgroundJobs([
    workflowAttempt({
      runId: 'wrun_active_old',
      state: 'running',
      step: 'QC',
      createdAt: '2026-10-23T00:01:00.000Z',
      active: true
    }),
    workflowAttempt({
      runId: 'wrun_failed_latest',
      state: 'failed',
      step: 'QC',
      createdAt: '2026-10-23T00:02:00.000Z'
    }),
    workflowAttempt({
      runId: 'wrun_align_done',
      state: 'completed',
      step: 'Alignment',
      createdAt: '2026-10-23T00:03:00.000Z'
    })
  ])
  assert.equal(activeWorkflow?.kind, 'workflow')
  if (activeWorkflow?.kind !== 'workflow') return
  assert.equal(activeWorkflow.active, true)
  assert.equal(workflowPhase(activeWorkflow), 'failed')
  assert.ok(activeWorkflow.jobs.some((job) => job.key === 'wrapper:wrun_active_old' && job.active))
})

test('workflow selection is stable in both input orders and stepless runs stay distinct', () => {
  const attempts = [
    workflowAttempt({
      runId: 'wrun_qc_failed',
      state: 'failed',
      step: 'QC',
      createdAt: '2026-10-23T00:01:00.000Z'
    }),
    workflowAttempt({
      runId: 'wrun_qc_retry',
      state: 'completed',
      step: 'QC',
      createdAt: '2026-10-23T00:02:00.000Z'
    }),
    workflowAttempt({
      runId: 'wrun_align',
      state: 'completed',
      step: 'Alignment',
      createdAt: '2026-10-23T00:03:00.000Z'
    })
  ]
  const forward = groupBackgroundJobs(attempts)
  const reverse = groupBackgroundJobs([...attempts].reverse())
  assert.equal(forward[0]?.kind, 'workflow')
  assert.equal(reverse[0]?.kind, 'workflow')
  if (forward[0]?.kind !== 'workflow' || reverse[0]?.kind !== 'workflow') return
  assert.deepEqual(
    forward[0].jobs.map((job) => job.run.runId),
    reverse[0].jobs.map((job) => job.run.runId)
  )
  assert.equal(forward[0].active, reverse[0].active)
  assert.equal(forward[0].totalSteps, reverse[0].totalSteps)
  assert.equal(workflowPhase(forward[0]), workflowPhase(reverse[0]))
  assert.deepEqual(workflowStepCounts(forward[0].jobs), workflowStepCounts(reverse[0].jobs))

  const stepless = [
    workflowAttempt({
      runId: 'wrun_stepless_a',
      state: 'completed',
      createdAt: '2026-10-23T00:04:00.000Z',
      totalSteps: null
    }),
    workflowAttempt({
      runId: 'wrun_stepless_b',
      state: 'failed',
      createdAt: '2026-10-23T00:05:00.000Z',
      totalSteps: null
    })
  ]
  const [steplessWorkflow] = groupBackgroundJobs(stepless)
  assert.equal(steplessWorkflow?.kind, 'workflow')
  if (steplessWorkflow?.kind !== 'workflow') return
  assert.equal(steplessWorkflow.expectedSteps, undefined)
  assert.equal(steplessWorkflow.totalSteps, 2)
  assert.equal(workflowPhase(steplessWorkflow), 'failed')
  assert.deepEqual(workflowStepCounts(steplessWorkflow.jobs), { completed: 1, failed: 1 })
})

test('a job that first appears already finished before the baseline is not announced as new', () => {
  const since = Date.parse('2026-11-11T10:00:00.000Z')
  const known = new Set<string>()
  const jobs = [
    { key: 'agent:old', active: false, timestamp: '2026-11-11T09:00:00.000Z' },
    { key: 'agent:quick', active: false, timestamp: '2026-11-11T10:00:05.000Z' },
    { key: 'agent:running', active: true, timestamp: '2026-11-11T09:30:00.000Z' }
  ]
  assert.deepEqual(
    newlyObservedJobs(jobs, known, since).map((job) => job.key),
    ['agent:quick', 'agent:running']
  )
  assert.ok(known.has('agent:old'))
  assert.deepEqual(newlyObservedJobs(jobs, known, since), [])
})
