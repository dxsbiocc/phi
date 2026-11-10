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
  const first = {
    kind: 'wrapper' as const,
    key: 'wrapper:wrun_1',
    active: false,
    timestamp: '2026-10-23T00:01:00.000Z',
    run: run('wrun_1', 'completed', 'rna')
  }
  const firstDisplay = groupBackgroundJobs([first])
  const known = new Set(firstDisplay.map((item) => item.key))
  assert.equal(workflowPhase(firstDisplay[0]), 'running')

  const later = [
    first,
    ...[2, 3, 4].map((index) => ({
      kind: 'wrapper' as const,
      key: `wrapper:wrun_${index}`,
      active: false,
      timestamp: `2026-10-23T00:0${index}:00.000Z`,
      run: run(`wrun_${index}`, 'completed', 'rna')
    }))
  ]
  const finalDisplay = groupBackgroundJobs(later)
  assert.deepEqual(newlyObservedJobs(finalDisplay, known), [])
  assert.equal(workflowPhase(finalDisplay[0]), 'completed')
  assert.equal(
    workflowPhase(groupBackgroundJobs([{ ...first, run: run('wrun_1', 'failed', 'rna') }])[0]),
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
