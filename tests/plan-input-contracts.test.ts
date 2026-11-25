import assert from 'node:assert/strict'
import test from 'node:test'

import { createPlanStepsExtension } from '../src/main/agent/engine/phi-extension/extensions/plan-steps'
import type { PhiExtensionHost } from '../src/main/agent/engine/phi-extension/host'
import { readScientificHandoff, scientificReport } from '../src/main/agent/agents/research-handoff'
import { buildStepPrompt } from '../src/main/agent/plan/execution/step-prompt'
import { createPlanRunState } from '../src/main/agent/plan/model/plan-run-state'
import { validatePlanSpec } from '../src/main/agent/plan/model/plan-spec'
import { planCopy } from '../src/renderer/src/features/plan/lib/planCopy'
import { planReviewItemFromEvent } from '../src/renderer/src/features/plan/lib/planReview'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

function capturePlanStepsToolSchema(): Record<string, unknown> {
  let captured: Record<string, unknown> | undefined
  const fakeHost = {
    nextActionSuggestionsEnabled: async () => false,
    planModeActive: () => true,
    planExecuteModeActive: () => true,
    proposePlanSteps: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    requestToolApproval: async () => undefined,
    browserApprovalInput: (_id: string, input: unknown) => input,
    markBrowserTextDenied: () => undefined,
    fallbackReadiness: () => ({ allowed: true, failures: 0 }),
    environmentBinding: () => undefined,
    hostEnvironment: () => ({})
  } satisfies PhiExtensionHost

  const factory = createPlanStepsExtension(fakeHost, { availableAgents: ['Wrapper', 'PlanStep'] })
  factory({
    registerTool(def: { parameters: unknown }) {
      captured = def.parameters as Record<string, unknown>
    }
  } as never)
  assert.ok(captured)
  return captured
}

test('propose_plan_steps schema exposes checks, inputContracts, and statisticalUnit under strict mode', () => {
  const schema = capturePlanStepsToolSchema()
  const props = schema.properties as Record<string, Record<string, unknown>>
  const stepItem = (props.steps.items as Record<string, unknown>).properties as Record<
    string,
    unknown
  >
  assert.ok(stepItem.checks, 'step schema must expose checks')
  assert.ok(stepItem.inputContracts, 'step schema must expose inputContracts')

  const hypItem = (props.hypotheses.items as Record<string, unknown>).properties as Record<
    string,
    unknown
  >
  assert.ok(hypItem.statisticalUnit, 'hypothesis schema must expose statisticalUnit')
})

test('validatePlanSpec normalizes valid inputContracts and blocks path traversal or invalid matrix semantics', () => {
  const valid = validatePlanSpec(
    {
      version: 1,
      goal: 'Test differential expression',
      researchQuestion: 'Which genes differ between tumor and normal per donor?',
      literatureReview: {
        needed: true,
        rationale: 'Establish myeloid signatures',
        references: ['DOI:10.1038/s41592-026-03029-6'],
        verificationStatus: 'verified'
      },
      hypotheses: [
        {
          id: 'h1',
          statement: 'Myeloid program increases in tumor',
          selected: true,
          statisticalUnit: 'donor',
          falsificationCriteria: 'Donor-paired |log2FC| < 0.5'
        }
      ],
      steps: [
        {
          id: 'fit-de',
          title: 'Fit paired DESeq2',
          instructions: 'Run DESeq2 wrapper',
          acceptance: 'results/de.tsv exists',
          dependsOn: [],
          access: 'write',
          writes: ['results/de.tsv'],
          checks: [
            {
              kind: 'table_schema',
              path: '/workspace/proj/results/de.tsv',
              format: 'tsv',
              minDataRows: 1,
              requiredColumns: ['gene_id', 'padj']
            }
          ],
          inputContracts: [
            {
              path: '/workspace/proj/counts/raw.tsv',
              expectedReferenceAssembly: 'GRCh38',
              mustMatchReferenceWith: 'counts/annot.gtf',
              requiredMatrixSemantics: ['raw_counts'],
              requireSampleMatchWith: 'meta/samples.csv',
              requireDonorMapping: true
            }
          ],
          hypothesisIds: ['h1']
        }
      ]
    },
    '/workspace/proj'
  )

  assert.equal(valid.ok, true)
  if (!valid.ok) return
  assert.equal(valid.spec.hypotheses?.[0]?.statisticalUnit, 'donor')
  assert.equal(valid.spec.literatureReview?.verificationStatus, 'verified')
  assert.equal(valid.spec.steps[0]?.inputContracts?.[0]?.path, 'counts/raw.tsv')

  const state = createPlanRunState({
    id: 'run-1',
    sessionId: 'sess-1',
    spec: valid.spec,
    now: '2026-11-24T00:00:00.000Z'
  })
  const prompt = buildStepPrompt(state, 'fit-de')
  assert.ok(prompt.includes('Statistical unit: donor'))

  // Escape & bad enum must fail validation cleanly
  const invalid = validatePlanSpec(
    {
      version: 1,
      goal: 'Bad contracts',
      hypotheses: [
        {
          id: 'h1',
          statement: 'Bad unit',
          selected: true,
          statisticalUnit: 'organoid'
        }
      ],
      steps: [
        {
          id: 's1',
          title: 'Step 1',
          instructions: 'Read',
          acceptance: 'Done',
          dependsOn: [],
          access: 'read',
          inputContracts: [
            {
              path: '../outside/secret.tsv',
              mustMatchReferenceWith: '/etc/passwd',
              requiredMatrixSemantics: ['bogus_unit']
            }
          ]
        }
      ]
    },
    '/workspace/proj'
  )
  assert.equal(invalid.ok, false)
  if (invalid.ok) return
  assert.ok(invalid.errors.some((e) => e.includes('inputContracts[0].path')))
  assert.ok(invalid.errors.some((e) => e.includes('statisticalUnit')))
})

test('scientificReport and readScientificHandoff round-trip hypothesisVerdicts and reject malformed verdicts', () => {
  const question = 'Does treatment alter expression?'
  const report = scientificReport(question, 'completed', {
    missingInputs: [],
    research: {
      subquestion: 'Test h1 on paired counts',
      answer: '0 of 1400 genes passed threshold.',
      interpretation: 'Null hypothesis retained under preset threshold.',
      rationale: 'Skip ORA due to empty candidate list.',
      evidence: ['results/de.tsv'],
      hypothesisVerdicts: [{ hypothesisId: 'h1', verdict: 'refuted' }]
    }
  })
  assert.equal(report.structured, true)
  const restored = readScientificHandoff(report.text, question, 'completed')
  assert.equal(restored.structured, true)
  const parsed = JSON.parse(restored.text) as {
    hypothesisVerdicts?: Array<{ hypothesisId: string; verdict: string }>
  }
  assert.deepEqual(parsed.hypothesisVerdicts, [{ hypothesisId: 'h1', verdict: 'refuted' }])

  const malformed = scientificReport(question, 'completed', {
    missingInputs: [],
    research: {
      subquestion: 'Test h1',
      answer: 'Done',
      interpretation: 'Done',
      rationale: 'Done',
      evidence: ['results/de.tsv'],
      hypothesisVerdicts: [{ hypothesisId: 'h1', verdict: 'proven_forever' }]
    }
  })
  assert.equal(malformed.structured, false)
})

test('planReview rehydration preserves hypotheses, literatureReview, checks, inputContracts, and live localization', () => {
  const item = planReviewItemFromEvent({
    type: 'plan_review_submitted',
    reviewId: 'rev-1',
    title: 'Plan',
    content: '# Plan',
    planFilePath: 'local://PLAN.md',
    steps: {
      version: 1,
      goal: 'Analyze cohort',
      literatureReview: {
        needed: true,
        rationale: 'Prior markers',
        verificationStatus: 'unverified_offline'
      },
      hypotheses: [{ id: 'h1', statement: 'Shift', selected: true, statisticalUnit: 'donor' }],
      steps: [
        {
          id: 's1',
          title: 'Step 1',
          instructions: 'Run',
          acceptance: 'Check',
          access: 'read',
          dependsOn: [],
          checks: [{ kind: 'file_exists', path: 'out.tsv' }],
          inputContracts: [{ path: 'in.tsv', requiredMatrixSemantics: ['raw_counts'] }],
          hypothesisIds: ['h1']
        }
      ]
    }
  })
  assert.ok(item?.steps?.literatureReview)
  assert.equal(item?.steps?.hypotheses?.[0]?.statisticalUnit, 'donor')
  assert.equal(item?.steps?.steps[0]?.checks?.length, 1)
  assert.equal(item?.steps?.steps[0]?.inputContracts?.length, 1)
  assert.deepEqual(item?.steps?.steps[0]?.hypothesisIds, ['h1'])

  setUiLanguage('en')
  assert.equal(planCopy.hypothesisStatisticalUnit('donor'), 'Statistical unit: donor')
  assert.equal(planCopy.literatureVerified, 'Citations verified')
  setUiLanguage('zh-CN')
  assert.equal(planCopy.hypothesisStatisticalUnit('donor'), '统计独立单位：donor')
  assert.equal(planCopy.literatureVerified, '引文已核验')
  setUiLanguage('en')
})
