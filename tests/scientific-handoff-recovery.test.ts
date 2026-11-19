import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readScientificHandoff,
  failedResearchReport
} from '../src/main/agent/agents/research-handoff'
import { parseAgentReport, type AgentReport } from '../src/main/agent/agents/report'
import {
  validatePlanRunState,
  createPlanRunState
} from '../src/main/agent/plan/model/plan-run-state'
import { buildStepPrompt } from '../src/main/agent/plan/execution/step-prompt'
import { replanPrompt } from '../src/main/agent/plan/replan-prompt'
import type { PlanRunState, PlanStepState } from '../src/shared/planRunTypes'

const question = '哪些基因达到预先批准的筛选阈值？'
const marker = 'INTERMEDIATE_TABLE_DO_NOT_FORWARD'
const answer = '3 个基因可评估，0 个达到阈值。'
const research = {
  subquestion: question,
  answer,
  interpretation: '这回答了候选基因问题。',
  rationale: '候选集为空，跳过 ORA。',
  evidence: ['results/差异分析.tsv']
}
function stateFor(step: Partial<PlanStepState>): PlanRunState {
  const state = createPlanRunState({
    id: 'p',
    sessionId: 's',
    now: '2026-11-19T00:00:00Z',
    spec: {
      version: 1,
      goal: question,
      researchQuestion: question,
      steps: [
        {
          id: 'de',
          title: '差异分析',
          instructions: question,
          acceptance: '核查结果表',
          access: 'read',
          dependsOn: []
        }
      ]
    }
  })
  state.steps.de = { status: 'pending', attempts: 1, ...step }
  return state
}

function handoff(values = research): AgentReport {
  return parseAgentReport(
    `<phi_agent_result>${JSON.stringify({
      status: 'completed',
      research: values,
      missingInputs: []
    })}</phi_agent_result>\n${marker}`,
    question
  )
}

test('a restored scientific handoff is bound to its original question and status', () => {
  const report = handoff()
  assert.deepEqual(readScientificHandoff(report.text, question, 'completed'), report)
  for (const invalid of [
    marker,
    JSON.stringify({ ...JSON.parse(report.text), originalQuestion: 'Another run', answer: marker }),
    JSON.stringify({ ...JSON.parse(report.text), status: 'unrecognized', answer: marker }),
    JSON.stringify({ ...JSON.parse(report.text), subquestion: `row\\n${marker}` }),
    JSON.stringify({ ...JSON.parse(report.text), evidence: [`a.tsv\\n${marker}`] }),
    JSON.stringify({ ...JSON.parse(report.text), missingInputs: [`rows\t${marker}`] }),
    JSON.stringify({ status: 'failed', originalQuestion: question, answer: marker })
  ]) {
    const safe = readScientificHandoff(invalid, question)
    assert.equal(safe.status, 'partial')
    assert.doesNotMatch(safe.text, new RegExp(marker))
  }
  assert.equal(readScientificHandoff(report.text, question, 'partial').status, 'partial')
  for (const cancelled of [true, false]) {
    const failure = failedResearchReport(question, cancelled)
    assert.deepEqual(readScientificHandoff(failure.text, question, 'failed'), failure)
  }
})

test('state restore, replan and retry project the same evidence and discard raw errors', () => {
  const report = handoff()
  for (const text of [report.text, marker.repeat(900)]) {
    const state = stateFor({
      report: { text, status: 'completed', missingInputs: [marker] },
      error: `stderr:\n${marker}`
    })
    const restored = validatePlanRunState(state)
    assert.ok(restored)
    assert.deepEqual(restored.steps.de.report!.missingInputs, [])
    for (const view of [
      JSON.stringify(restored),
      replanPrompt(state),
      buildStepPrompt(state, 'de')
    ]) {
      assert.doesNotMatch(view, new RegExp(marker))
      assert.ok(view.includes(text === report.text ? answer : 'Insufficient evidence'))
    }
  }
})

test('small retry and replan budgets omit whole scientific claims and keep evidence references', () => {
  const longAnswer = '治疗前后的样本。'.repeat(55)
  const report = handoff({
    ...research,
    answer: longAnswer,
    interpretation: '效应。'.repeat(90),
    rationale: '限制。'.repeat(90)
  })
  assert.equal(report.status, 'completed')
  assert.ok(Buffer.byteLength(report.text) > 2048)
  const state = stateFor({ report })
  assert.equal(validatePlanRunState(state)?.steps.de.report?.text, report.text)
  for (const prompt of [buildStepPrompt(state, 'de'), replanPrompt(state)]) {
    assert.ok(prompt.includes('handoff omitted'))
    assert.ok(prompt.includes(research.evidence[0]))
    assert.ok(!prompt.includes(longAnswer.slice(0, 20)))
  }
})
