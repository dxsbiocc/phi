import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readScientificHandoff,
  failedResearchReport,
  scientificReport
} from '../src/main/agent/agents/research-handoff'
import { parseAgentReport, type AgentReport } from '../src/main/agent/agents/report'
import {
  validatePlanRunState,
  createPlanRunState
} from '../src/main/agent/plan/model/plan-run-state'
import { buildStepPrompt } from '../src/main/agent/plan/execution/step-prompt'
import { replanPrompt } from '../src/main/agent/plan/replan-prompt'
import {
  PLAN_MAX_REPORT_SUMMARY_BYTES,
  type PlanRunState,
  type PlanStepState
} from '../src/shared/planRunTypes'

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

const missingInput = '缺少供体编号与实验设计'
const donorQuestion = {
  header: '供体选择',
  question: '应使用哪个供体的样本继续差异分析？',
  options: [
    { label: '供体 A（推荐）', description: '沿用已批准的供体 A 样本，保持原设计。' },
    { label: '供体 B', description: '改用供体 B 样本，需要重新评估批次效应。' }
  ]
}

function handoffWith(
  status: string,
  researchValues: Record<string, unknown>,
  missing: string[]
): AgentReport {
  return parseAgentReport(
    `<phi_agent_result>${JSON.stringify({
      status,
      research: researchValues,
      missingInputs: missing
    })}</phi_agent_result>\n${marker}`,
    question
  )
}

test('blocked and partial handoffs keep a validated user question verbatim across replay', () => {
  for (const status of ['blocked', 'partial'] as const) {
    const report = handoffWith(status, { ...research, question: donorQuestion }, [missingInput])
    assert.equal(report.status, status)
    assert.deepEqual(JSON.parse(report.text).question, donorQuestion)
    assert.deepEqual(readScientificHandoff(report.text, question, status), report)
    assert.deepEqual(readScientificHandoff(report.text, question), report)
  }
  const projected = handoffWith(
    'blocked',
    {
      ...research,
      question: {
        ...donorQuestion,
        multiSelect: true,
        extra: marker,
        options: donorQuestion.options.map((option) => ({ ...option, preview: '```log```' }))
      }
    },
    [missingInput]
  )
  assert.deepEqual(JSON.parse(projected.text).question, donorQuestion)
  assert.doesNotMatch(projected.text, new RegExp(marker))
})

test('a question is kept only for blocked or partial reports with missing inputs', () => {
  const completed = handoffWith('completed', { ...research, question: donorQuestion }, [])
  assert.equal(completed.text, handoff().text)
  assert.deepEqual(readScientificHandoff(completed.text, question, 'completed'), handoff())
  for (const [status, missing] of [
    ['partial', []],
    ['not_found', [missingInput]],
    ['completed', [missingInput]]
  ] as const) {
    const report = handoffWith(status, { ...research, question: donorQuestion }, [...missing])
    assert.equal(report.status, status)
    assert.equal(JSON.parse(report.text).question, undefined)
    assert.deepEqual(readScientificHandoff(report.text, question, status), report)
  }
})

test('invalid questions are omitted without leaking or erasing the report', () => {
  const base = handoffWith('blocked', research, [missingInput])
  const invalid: unknown[] = [
    '请告诉我供体',
    { ...donorQuestion, header: '长'.repeat(17) },
    { ...donorQuestion, question: `哪个供体？\n${marker}` },
    { ...donorQuestion, question: `哪个供体？\\n${marker}` },
    { ...donorQuestion, question: '```\n' + marker },
    { ...donorQuestion, options: [donorQuestion.options[0]] },
    {
      ...donorQuestion,
      options: [...donorQuestion.options, ...donorQuestion.options, donorQuestion.options[0]]
    },
    { ...donorQuestion, options: [donorQuestion.options[0], donorQuestion.options[0]] },
    ...['Other', 'Type something.', 'Next'].map((label) => ({
      ...donorQuestion,
      options: [{ label, description: '自定义输入。' }, donorQuestion.options[1]]
    })),
    {
      ...donorQuestion,
      options: [{ label: '长'.repeat(61), description: '自定义输入。' }, donorQuestion.options[1]]
    },
    {
      ...donorQuestion,
      options: [{ label: '供体 A', description: '' }, donorQuestion.options[1]]
    },
    { ...donorQuestion, options: [{ label: '供体 A' }, donorQuestion.options[1]] },
    {
      ...donorQuestion,
      options: [{ label: `供体\t${marker}`, description: '自定义输入。' }, donorQuestion.options[1]]
    }
  ]
  for (const questionValue of invalid) {
    const report = handoffWith('blocked', { ...research, question: questionValue }, [missingInput])
    assert.equal(report.status, 'blocked')
    assert.equal(report.text, base.text)
    assert.doesNotMatch(report.text, new RegExp(marker))
    assert.deepEqual(readScientificHandoff(report.text, question, 'blocked'), base)
  }
  const tampered = JSON.stringify({
    ...JSON.parse(base.text),
    question: { ...donorQuestion, question: `哪个供体？\n${marker}` }
  })
  const replayed = readScientificHandoff(tampered, question, 'blocked')
  assert.equal(replayed.text, base.text)
  assert.doesNotMatch(replayed.text, new RegExp(marker))
})

test('restore, replan and retry prompts keep the choices and drop logs', () => {
  const report = handoffWith('blocked', { ...research, question: donorQuestion }, [missingInput])
  const state = stateFor({
    report: { text: report.text, status: 'blocked', missingInputs: [missingInput] },
    error: `stderr:\n${marker}`
  })
  const restored = validatePlanRunState(state)
  assert.ok(restored)
  assert.equal(restored.steps.de.report?.text, report.text)
  assert.deepEqual(restored.steps.de.report?.missingInputs, [missingInput])
  for (const view of [
    JSON.stringify(restored),
    replanPrompt(state),
    buildStepPrompt(state, 'de')
  ]) {
    assert.doesNotMatch(view, new RegExp(marker))
    assert.ok(view.includes(donorQuestion.question))
    for (const option of donorQuestion.options) {
      assert.ok(view.includes(option.label))
      assert.ok(view.includes(option.description))
    }
  }
})

test('a question that overflows the report allowance is dropped, not the report', () => {
  const filler = (n: number): string => '限'.repeat(n)
  const missing = [filler(160), filler(160), filler(160), filler(160)]
  const bigResearch = {
    subquestion: filler(320),
    answer: filler(480),
    interpretation: filler(320),
    rationale: filler(320),
    evidence: [`results/${filler(240)}.tsv`, `results/${filler(240)}.tsv`]
  }
  let answerLength = 480
  let base = scientificReport(question, 'blocked', {
    research: bigResearch,
    missingInputs: missing
  })
  while (base.status !== 'blocked' && answerLength > 0) {
    answerLength -= 10
    base = scientificReport(question, 'blocked', {
      research: { ...bigResearch, answer: filler(answerLength) },
      missingInputs: missing
    })
  }
  assert.equal(base.status, 'blocked')
  assert.ok(Buffer.byteLength(base.text, 'utf8') <= PLAN_MAX_REPORT_SUMMARY_BYTES)
  const bigQuestion = {
    header: filler(16),
    question: filler(320),
    options: [1, 2, 3, 4].map((n) => ({ label: `${filler(58)}${n}`, description: filler(320) }))
  }
  const withQuestion = scientificReport(question, 'blocked', {
    research: { ...bigResearch, answer: filler(answerLength), question: bigQuestion },
    missingInputs: missing
  })
  assert.equal(withQuestion.status, 'blocked')
  assert.equal(withQuestion.text, base.text)
  assert.deepEqual(readScientificHandoff(withQuestion.text, question, 'blocked'), base)
})
