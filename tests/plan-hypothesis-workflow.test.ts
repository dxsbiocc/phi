import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPhiMainSystemPrompt } from '../src/main/agent/engine/phi-extension/lib/phi-main-system-prompt'
import { rpcWorkModePrompt } from '../src/main/agent/engine/phi-extension/lib/rpc-plan-prompt'
import { buildStepPrompt } from '../src/main/agent/plan/execution/step-prompt'
import { createPlanRunState } from '../src/main/agent/plan/model/plan-run-state'
import { validatePlanSpec } from '../src/main/agent/plan/model/plan-spec'
import { planReviewContent } from '../src/main/agent/plan/plan-review-content'
import { replanPrompt } from '../src/main/agent/plan/replan-prompt'
import type { PlanSpec } from '../src/shared/planRunTypes'

function sampleHypothesisPlan(): PlanSpec {
  return {
    version: 1,
    goal: 'Test candidate biological hypotheses with workspace tools',
    literatureReview: {
      needed: true,
      rationale: 'Prior mechanism and confounder evidence informs competing hypotheses.',
      scope: 'Pathway X regulation under Condition A vs. batch artifacts',
      databases: ['PubMed', 'bioRxiv'],
      synthesis:
        'Peer-reviewed studies report pathway X activation, while preprint reports highlight batch confounding.',
      references: ['PMID:12345678', 'https://doi.org/10.1000/example']
    },
    hypotheses: [
      {
        id: 'h1',
        statement: 'Condition A upregulates pathway X relative to control.',
        mechanism: 'Ligand activation drives downstream TF phosphorylation of pathway X targets.',
        rationale: 'Prior pilot signal suggested pathway X shift.',
        selected: true,
        prediction: 'Pathway X core genes show positive log2FoldChange > 1.0 after donor adjustment.',
        testCriteria: 'Adjusted p < 0.05 and positive log2FoldChange in pathway X genes',
        falsificationCriteria:
          'No significant enrichment (padj >= 0.05) or reversed fold-change after controlling for donor',
        confounders: ['donor_id', 'sequencing_batch']
      },
      {
        id: 'h2',
        statement: 'Batch effect drives the primary variance axis.',
        selected: false,
        testCriteria: 'PC1 correlates with batch metadata (R^2 > 0.5)'
      }
    ],
    steps: [
      {
        id: 'verify-h1',
        title: 'Run differential test for H1',
        instructions: 'Compute differential statistics on counts.tsv and export results/h1.tsv.',
        acceptance: 'results/h1.tsv exists with adjusted p-values and fold changes.',
        dependsOn: [],
        access: 'write',
        writes: ['results/h1.tsv'],
        hypothesisIds: ['h1']
      }
    ]
  }
}

test('validatePlanSpec validates enriched literatureReview, competing hypotheses, and step.hypothesisIds', () => {
  const valid = validatePlanSpec(sampleHypothesisPlan())
  assert.equal(valid.ok, true)
  if (valid.ok) {
    assert.equal(valid.spec.literatureReview?.needed, true)
    assert.deepEqual(valid.spec.literatureReview?.databases, ['PubMed', 'bioRxiv'])
    assert.ok(valid.spec.literatureReview?.synthesis)
    assert.equal(valid.spec.hypotheses?.length, 2)
    assert.equal(valid.spec.hypotheses?.[0]?.falsificationCriteria?.includes('padj >= 0.05'), true)
    assert.deepEqual(valid.spec.hypotheses?.[0]?.confounders, ['donor_id', 'sequencing_batch'])
    assert.deepEqual(valid.spec.steps[0]?.hypothesisIds, ['h1'])
  }

  // Reject when no hypothesis is selected.
  const noneSelected = sampleHypothesisPlan()
  noneSelected.hypotheses = noneSelected.hypotheses!.map((h) => ({ ...h, selected: false }))
  const resNone = validatePlanSpec(noneSelected)
  assert.equal(resNone.ok, false)
  if (!resNone.ok) {
    assert.ok(resNone.errors.some((e) => e.includes('at least one hypothesis as selected')))
  }

  // Reject when step references unknown hypothesis ID.
  const unknownRef = sampleHypothesisPlan()
  unknownRef.steps[0]!.hypothesisIds = ['h-missing']
  const resUnknown = validatePlanSpec(unknownRef)
  assert.equal(resUnknown.ok, false)
  if (!resUnknown.ok) {
    assert.ok(resUnknown.errors.some((e) => e.includes('references missing hypothesis "h-missing"')))
  }

  // Reject missing literatureReview rationale.
  const badLit = sampleHypothesisPlan()
  badLit.literatureReview = { needed: true, rationale: '' }
  const resLit = validatePlanSpec(badLit)
  assert.equal(resLit.ok, false)
  if (!resLit.ok) {
    assert.ok(resLit.errors.some((e) => e.includes('literatureReview.rationale')))
  }
})

test('buildStepPrompt, planReviewContent, and replanPrompt propagate synthesis, falsification, and confounders', () => {
  const spec = sampleHypothesisPlan()
  const state = createPlanRunState({
    id: 'run-hyp-1',
    sessionId: 'sess-1',
    spec,
    now: '2026-11-23T00:00:00.000Z'
  })

  const stepPrompt = buildStepPrompt(state, 'verify-h1')
  assert.match(stepPrompt, /## Hypotheses under test/u)
  assert.match(stepPrompt, /\[h1\] Condition A upregulates pathway X/u)
  assert.match(stepPrompt, /Mechanism: Ligand activation/u)
  assert.match(stepPrompt, /Prediction: Pathway X core genes/u)
  assert.match(stepPrompt, /Falsification: No significant enrichment/u)
  assert.match(stepPrompt, /Confounders\/controls: donor_id, sequencing_batch/u)
  assert.match(stepPrompt, /avoid pseudoreplication/u)
  assert.doesNotMatch(stepPrompt, /\[h2\]/u)

  const reviewMd = planReviewContent(spec)
  assert.match(reviewMd, /Literature review \(performed\)/u)
  assert.match(reviewMd, /Sources: PubMed, bioRxiv/u)
  assert.match(reviewMd, /Synthesis: Peer-reviewed studies/u)
  assert.match(reviewMd, /\[selected\] h1:/u)
  assert.match(reviewMd, /falsification: No significant enrichment/u)
  assert.match(reviewMd, /hypotheses: h1/u)

  const replan = replanPrompt(state)
  assert.match(replan, /"literatureReview"/u)
  assert.match(replan, /"falsificationCriteria"/u)
})

test('system and RPC work-mode prompts enforce adaptive thematic literature review and falsifiable competing hypotheses', () => {
  const autoBlocks = buildPhiMainSystemPrompt([], { workMode: 'auto' }).join('\n')
  assert.match(autoBlocks, /always plan and generate candidate hypotheses/iu)

  const planExecuteBlocks = buildPhiMainSystemPrompt([], { workMode: 'plan_execute' }).join('\n')
  assert.match(planExecuteBlocks, /Do NOT run literature retrieval blindly/u)
  assert.match(planExecuteBlocks, /synthesize findings thematically/u)
  assert.match(planExecuteBlocks, /falsification criteria/iu)
  assert.match(planExecuteBlocks, /pseudoreplication/iu)
  assert.match(planExecuteBlocks, /ask_user_question/u)
  assert.match(planExecuteBlocks, /hypothesisIds/u)

  const rpcAuto = rpcWorkModePrompt('auto', ['enter_plan_mode'], ['enter_plan_mode']) ?? ''
  assert.match(rpcAuto, /always plan and generate candidate hypotheses/iu)

  const rpcPlanExec =
    rpcWorkModePrompt('plan_execute', ['propose_plan_steps'], ['propose_plan_steps']) ?? ''
  assert.match(rpcPlanExec, /synthesize thematically/u)
  assert.match(rpcPlanExec, /falsificationCriteria/u)
  assert.match(rpcPlanExec, /ask_user_question/u)
  assert.match(rpcPlanExec, /hypothesisIds/u)
})
