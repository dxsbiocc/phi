import assert from 'node:assert/strict'
import test from 'node:test'

import {
  continuationPrompt,
  planRunContinuationPrompt
} from '../src/main/agent/agents/run-continue'
import { RESEARCH_RESULT_REVIEW } from '../src/main/agent/agents/leader-prompt'
import { scientificReport } from '../src/main/agent/agents/research-handoff'
import type {
  PlanRunFinishedEvent,
  PlanStepReportStatus,
  PlanStepReportSummary,
  PlanStepState
} from '../src/shared/planRunTypes'

const QUESTION = 'Which genes passed the prespecified differential-expression thresholds?'
const SENTINEL = 'PHI_PLAN_WAKE_RAW_LOG_SENTINEL_7f3a'
const MAX_LENGTH = 20_000

const ZERO_DEG = {
  subquestion: 'Apply the prespecified differential-expression filter.',
  answer: '0 of 3 evaluable genes met the thresholds (padj < 0.05, |log2FC| >= 1).',
  interpretation:
    'No candidate list exists for over-representation analysis under these thresholds.',
  rationale:
    'Deliver the requested gene list; a ranked pathway test would answer a separate question.',
  evidence: ['results/differential.tsv']
}

function handoffReport(
  status: PlanStepReportStatus,
  research: Record<string, unknown>,
  question: string = QUESTION
): PlanStepReportSummary {
  const report = scientificReport(question, status, { research, missingInputs: [] })
  assert.equal(report.structured, true, 'test fixture must be a valid scientific handoff')
  return { status: report.status, text: report.text, missingInputs: report.missingInputs }
}

function planEvent(input: {
  runId: string
  goal?: string
  researchQuestion?: string
  steps: Array<{ id: string; title?: string; state: PlanStepState }>
}): PlanRunFinishedEvent {
  return {
    type: 'plan_run_finished',
    runId: input.runId,
    state: {
      id: input.runId,
      sessionId: 'phi-1',
      spec: {
        version: 1,
        goal: input.goal ?? 'Answer the research question',
        ...(input.researchQuestion !== undefined
          ? { researchQuestion: input.researchQuestion }
          : {}),
        steps: input.steps.map(({ id, title }) => ({
          id,
          title: title ?? `Step ${id}`,
          instructions: 'Do it.',
          acceptance: 'Done.',
          dependsOn: [],
          access: 'read' as const
        }))
      },
      status: 'completed',
      steps: Object.fromEntries(input.steps.map(({ id, state }) => [id, state])),
      replans: 0,
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:01:00.000Z'
    }
  }
}

function done(report: PlanStepReportSummary): PlanStepState {
  return { status: 'done', attempts: 1, report }
}

function handoffLines(prompt: string): Array<Record<string, unknown>> {
  return prompt
    .split('\n')
    .filter((line) => line.startsWith('  {'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function zeroDegPlan(runId = 'plan-deg'): PlanRunFinishedEvent {
  return planEvent({
    runId,
    researchQuestion: QUESTION,
    steps: [
      {
        id: 'de-filter',
        title: 'Differential filter',
        state: done(handoffReport('completed', ZERO_DEG))
      }
    ]
  })
}

test('a research plan wake carries the bound question, status and the complete zero-DEG handoff with its file reference', () => {
  const prompt = planRunContinuationPrompt([zeroDegPlan()])
  assert.match(prompt, /^<phi_plan_run_finished>/)
  assert.ok(prompt.includes(QUESTION))
  assert.match(prompt, /- de-filter · Differential filter · done/)
  assert.ok(prompt.includes(RESEARCH_RESULT_REVIEW))
  const handoffs = handoffLines(prompt)
  assert.equal(handoffs.length, 1)
  assert.equal(handoffs[0].originalQuestion, QUESTION)
  assert.equal(handoffs[0].status, 'completed')
  assert.equal(handoffs[0].answer, ZERO_DEG.answer)
  assert.equal(handoffs[0].interpretation, ZERO_DEG.interpretation)
  assert.equal(handoffs[0].rationale, ZERO_DEG.rationale)
  assert.deepEqual(handoffs[0].evidence, ['results/differential.tsv'])
  assert.ok(!prompt.includes('(summary omitted:'))
  assert.ok(!prompt.includes('… (omitted for budget:'))
  assert.ok(!prompt.includes('truncated'))
  assert.ok(prompt.length <= MAX_LENGTH)
  assert.match(continuationPrompt([zeroDegPlan()]), /<phi_plan_run_finished>/)
})

test('a free-prose report with a giant table and raw log never reaches main', () => {
  const raw = `gene_id\tpadj\tlog2FoldChange\nG1\t0.05\t2\n${SENTINEL.repeat(2000)}`
  const event = planEvent({
    runId: 'plan-legacy-report',
    researchQuestion: QUESTION,
    steps: [
      {
        id: 'de-filter',
        state: {
          status: 'done',
          attempts: 1,
          report: { status: 'completed', text: raw, missingInputs: [] }
        }
      }
    ]
  })
  const prompt = planRunContinuationPrompt([event])
  assert.ok(!prompt.includes(SENTINEL))
  assert.ok(!prompt.includes('log2FoldChange'))
  assert.ok(prompt.includes(QUESTION))
  assert.match(prompt, /- de-filter · Step de-filter · done/)
  assert.match(
    prompt,
    /\(insufficient evidence: this step has no valid scientific handoff; inspect plan run plan-legacy-report step de-filter\)/
  )
  assert.deepEqual(handoffLines(prompt), [])
  assert.ok(prompt.length <= MAX_LENGTH)
})

test('a giant raw step error is replaced by the insufficient-evidence reference', () => {
  const event = planEvent({
    runId: 'plan-error',
    researchQuestion: QUESTION,
    steps: [
      { id: 'de-filter', state: { status: 'failed', attempts: 2, error: SENTINEL.repeat(2000) } }
    ]
  })
  const prompt = planRunContinuationPrompt([event])
  assert.ok(!prompt.includes(SENTINEL))
  assert.match(prompt, /- de-filter · Step de-filter · failed/)
  assert.match(prompt, /insufficient evidence: this step has no valid scientific handoff/)
  assert.match(prompt, /inspect plan run plan-error step de-filter/)
  assert.ok(prompt.includes(QUESTION))
})

test('a handoff bound to another question or status is not forwarded', () => {
  const stale = handoffReport('completed', ZERO_DEG, 'A different, earlier research question')
  const mismatched: PlanStepReportSummary = {
    ...handoffReport('completed', ZERO_DEG),
    status: 'partial'
  }
  const event = planEvent({
    runId: 'plan-stale',
    researchQuestion: QUESTION,
    steps: [
      { id: 's1', state: done(stale) },
      { id: 's2', state: done(mismatched) }
    ]
  })
  const prompt = planRunContinuationPrompt([event])
  assert.ok(!prompt.includes('A different, earlier research question'))
  assert.deepEqual(handoffLines(prompt), [])
  assert.match(prompt, /inspect plan run plan-stale step s1/)
  assert.match(prompt, /inspect plan run plan-stale step s2/)
})

test('a stored unavailable fallback stays an insufficient-evidence gap', () => {
  const fallback = scientificReport(QUESTION, 'partial')
  const event = planEvent({
    runId: 'plan-fallback',
    researchQuestion: QUESTION,
    steps: [
      {
        id: 's1',
        state: done({
          status: fallback.status,
          text: fallback.text,
          missingInputs: fallback.missingInputs
        })
      }
    ]
  })
  const prompt = planRunContinuationPrompt([event])
  assert.deepEqual(handoffLines(prompt), [])
  assert.match(prompt, /insufficient evidence: this step has no valid scientific handoff/)
})

test('an all-skipped research plan keeps the question and statuses without inventing evidence', () => {
  const event = planEvent({
    runId: 'plan-skipped',
    researchQuestion: QUESTION,
    steps: [
      { id: 's1', state: { status: 'skipped', attempts: 0 } },
      { id: 's2', state: { status: 'skipped', attempts: 0 } }
    ]
  })
  const prompt = planRunContinuationPrompt([event])
  assert.ok(prompt.includes(QUESTION))
  assert.match(prompt, /- s1 · Step s1 · skipped/)
  assert.match(prompt, /- s2 · Step s2 · skipped/)
  assert.ok(prompt.includes(RESEARCH_RESULT_REVIEW))
  assert.deepEqual(handoffLines(prompt), [])
  assert.ok(!prompt.includes('(insufficient evidence:'))
  assert.ok(!prompt.includes('(summary omitted:'))
})

test('a mixed coalesced wake keeps the research handoff and the legacy plan within one budget', () => {
  const legacy = planEvent({
    runId: 'plan-legacy',
    goal: 'Prepare the report',
    steps: [
      {
        id: 'report',
        title: 'Write report',
        state: done({ status: 'completed', text: 'Shortest route is A-B-F.', missingInputs: [] })
      }
    ]
  })
  const prompt = continuationPrompt([zeroDegPlan(), legacy])
  assert.ok(prompt.includes(QUESTION))
  assert.ok(prompt.includes('Shortest route is A-B-F.'))
  assert.ok(prompt.includes('Prepare the report'))
  assert.ok(prompt.includes(RESEARCH_RESULT_REVIEW))
  assert.equal(handoffLines(prompt).length, 1)
  assert.ok(prompt.length <= MAX_LENGTH)
})

test('a legacy plan in a mixed wake cannot flood the wake with a giant report', () => {
  const legacy = planEvent({
    runId: 'plan-legacy-big',
    goal: 'Prepare the report',
    steps: [
      {
        id: 'report',
        state: done({
          status: 'completed',
          text: `${'r'.repeat(30_000)}${SENTINEL}`,
          missingInputs: []
        })
      }
    ]
  })
  const prompt = planRunContinuationPrompt([zeroDegPlan(), legacy])
  assert.ok(prompt.length <= MAX_LENGTH)
  assert.ok(!prompt.includes(SENTINEL))
  assert.ok(prompt.includes(QUESTION))
})

function bulkyResearch(index: number): Record<string, unknown> {
  return {
    subquestion: `Subquestion ${index}: ${'q'.repeat(320)}`.slice(0, 320),
    answer: `Answer ${index}: ${'a'.repeat(480)}`.slice(0, 480),
    interpretation: `Interpretation ${index}: ${'i'.repeat(320)}`.slice(0, 320),
    rationale: `Rationale ${index}: ${'r'.repeat(320)}`.slice(0, 320),
    evidence: [`results/step-${index}-${'e'.repeat(200)}.tsv`]
  }
}

function bulkyPlan(runId: string): PlanRunFinishedEvent {
  return planEvent({
    runId,
    researchQuestion: QUESTION,
    steps: Array.from({ length: 20 }, (_, index) => ({
      id: `step-${index}`,
      state: done(handoffReport('completed', bulkyResearch(index)))
    }))
  })
}

test('oversized scientific summaries are omitted whole with run/step lookup hints, never cut mid-claim', () => {
  const prompt = planRunContinuationPrompt([bulkyPlan('plan-bulk')])
  assert.ok(prompt.length <= MAX_LENGTH)
  assert.ok(prompt.includes(QUESTION))
  for (let index = 0; index < 20; index += 1) {
    assert.ok(prompt.includes(`- step-${index} · Step step-${index} · done`))
  }
  const handoffs = handoffLines(prompt)
  assert.ok(handoffs.length > 0 && handoffs.length < 20)
  for (const handoff of handoffs) {
    const index = Number(String(handoff.subquestion).match(/^Subquestion (\d+):/)?.[1])
    assert.equal(handoff.answer, bulkyResearch(index).answer, 'an included claim must be complete')
    assert.equal(handoff.originalQuestion, QUESTION)
  }
  const hints = prompt
    .split('\n')
    .filter((line) => line.includes('(summary omitted: wake-up budget;'))
  assert.ok(hints.length > 0)
  for (const hint of hints) {
    assert.match(hint, /inspect plan run plan-bulk step step-\d+\)$/)
  }
  assert.ok(prompt.includes(RESEARCH_RESULT_REVIEW))
})

test('many coalesced research plans stay within the wake-up budget with an explicit omission marker', () => {
  const events = Array.from({ length: 6 }, (_, index) => bulkyPlan(`plan-bulk-${index}`))
  const prompt = planRunContinuationPrompt(events)
  assert.ok(prompt.length <= MAX_LENGTH)
  assert.match(prompt, /… \(omitted for budget: plan-bulk-\d/)
  assert.match(prompt, /inspect the stored plan records\)/)
  assert.ok(prompt.includes(QUESTION))
  for (const handoff of handoffLines(prompt)) {
    const index = Number(String(handoff.subquestion).match(/^Subquestion (\d+):/)?.[1])
    assert.equal(handoff.answer, bulkyResearch(index).answer)
  }
})

test('a legacy ordinary plan wake keeps its previous format and policy', () => {
  const legacy = planEvent({
    runId: 'plan-legacy',
    goal: 'Prepare the report',
    steps: [
      {
        id: 'report',
        title: 'Write report',
        state: done({ status: 'completed', text: 'Shortest route is A-B-F.', missingInputs: [] })
      }
    ]
  })
  const prompt = planRunContinuationPrompt([legacy])
  assert.match(prompt, /^<phi_plan_run_finished>/)
  assert.match(prompt, /Goal: Prepare the report/)
  assert.match(prompt, /- report · Write report · done/)
  assert.ok(prompt.includes('Shortest route is A-B-F.'))
  assert.ok(!prompt.includes('Research question'))
  assert.ok(!prompt.includes(RESEARCH_RESULT_REVIEW))
  assert.ok(!prompt.includes('Plan run plan-legacy · goal:'))
})
