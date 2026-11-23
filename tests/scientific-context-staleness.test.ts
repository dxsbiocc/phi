import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { PlanSpec } from '../src/shared/planRunTypes'
import { observedValue } from '../src/shared/scientificContextTypes'
import { writeScientificContextSidecar } from '../src/main/agent/scientific-context/sidecar'
import {
  captureStepEvidenceFingerprint,
  createDerivedRerunPlanSpec,
  evaluatePlanStaleness
} from '../src/main/agent/scientific-context/staleness'

function makeBranchingPlan(): PlanSpec {
  return {
    version: 1,
    goal: 'Branching RNA-seq analysis',
    steps: [
      {
        id: 'branch-a',
        title: 'Analyze cohort A',
        instructions: 'Process cohort A counts',
        acceptance: 'A done',
        dependsOn: [],
        access: 'write',
        inputContracts: [{ path: 'data/cohort_a.tsv' }]
      },
      {
        id: 'downstream-a',
        title: 'Pathway A',
        instructions: 'Enrich cohort A DE genes',
        acceptance: 'Pathway A done',
        dependsOn: ['branch-a'],
        access: 'write'
      },
      {
        id: 'branch-b',
        title: 'Analyze cohort B',
        instructions: 'Process cohort B counts',
        acceptance: 'B done',
        dependsOn: [],
        access: 'write',
        inputContracts: [{ path: 'data/cohort_b.tsv' }]
      },
      {
        id: 'downstream-b',
        title: 'Pathway B',
        instructions: 'Enrich cohort B DE genes',
        acceptance: 'Pathway B done',
        dependsOn: ['branch-b'],
        access: 'write'
      }
    ]
  }
}

test('same-path file replacement propagates staleness only to affected descendants while leaving sibling branches clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-r15-stale-'))
  try {
    mkdirSync(join(dir, 'data'), { recursive: true })
    const fileA = join(dir, 'data', 'cohort_a.tsv')
    const fileB = join(dir, 'data', 'cohort_b.tsv')
    writeFileSync(fileA, 'gene_id\tS1\nG1\t10\n')
    writeFileSync(fileB, 'gene_id\tS2\nG1\t20\n')
    writeScientificContextSidecar(fileA, {
      producer: { kind: 'wrapper', id: 'salmon' },
      location: 'local',
      path: fileA,
      hashLocalBytes: true,
      matrix: observedValue({ valueSemantics: 'raw_counts' }, 'salmon')
    })
    writeScientificContextSidecar(fileB, {
      producer: { kind: 'wrapper', id: 'salmon' },
      location: 'local',
      path: fileB,
      hashLocalBytes: true,
      matrix: observedValue({ valueSemantics: 'raw_counts' }, 'salmon')
    })

    const spec = makeBranchingPlan()
    const fingerprints = Object.fromEntries(
      spec.steps.map((step) => [step.id, captureStepEvidenceFingerprint(step, dir, '1.0.0')])
    )

    // Unchanged -> all steps clean.
    const initial = evaluatePlanStaleness(spec, fingerprints, dir, '1.0.0')
    assert.deepEqual(Object.keys(initial.staleSteps), [])
    assert.equal(initial.cleanStepIds.length, 4)

    // Replace cohort_a.tsv at the exact same path -> only branch-a and downstream-a become stale.
    writeFileSync(fileA, 'gene_id\tS1\nG1\t999\n')
    const afterReplace = evaluatePlanStaleness(spec, fingerprints, dir, '1.0.0')
    assert.deepEqual(Object.keys(afterReplace.staleSteps).sort(), ['branch-a', 'downstream-a'])
    assert.deepEqual(afterReplace.cleanStepIds.sort(), ['branch-b', 'downstream-b'])
    assert.match(afterReplace.staleSteps['branch-a'].directReasons[0], /same-path replacement/)
    assert.deepEqual(afterReplace.staleSteps['downstream-a'].propagatedFrom, ['branch-a'])

    // Derived rerun plan preserves original spec untouched and only schedules the stale subgraph.
    const rerun = createDerivedRerunPlanSpec(
      'prun_orig_1',
      spec,
      Object.keys(afterReplace.staleSteps)
    )
    assert.equal(spec.steps.length, 4, 'original plan spec must remain immutable')
    assert.match(rerun.goal, /prun_orig_1/)
    assert.deepEqual(
      rerun.steps.map((s) => s.id),
      ['branch-a', 'downstream-a']
    )
    assert.deepEqual(rerun.steps[1].dependsOn, ['branch-a'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('compatibility rule version bump invalidates recorded steps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-r15-rules-'))
  try {
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(join(dir, 'data', 'cohort_a.tsv'), 'gene_id\tS1\nG1\t10\n')
    writeFileSync(join(dir, 'data', 'cohort_b.tsv'), 'gene_id\tS2\nG1\t20\n')

    const spec = makeBranchingPlan()
    const fingerprints = Object.fromEntries(
      spec.steps.map((step) => [step.id, captureStepEvidenceFingerprint(step, dir, '1.0.0')])
    )
    const report = evaluatePlanStaleness(spec, fingerprints, dir, '2.0.0')
    assert.equal(Object.keys(report.staleSteps).length, 4)
    assert.match(report.staleSteps['branch-a'].directReasons[0], /rules changed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
