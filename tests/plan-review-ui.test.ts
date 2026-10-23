import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import type { PlanSpec } from '../src/shared/planRunTypes'
import UserInteractionPanel from '../src/renderer/src/components/UserInteractionPanel'
import { PlanReviewCard } from '../src/renderer/src/features/plan/components/PlanReviewCard'
import {
  applyPlanReviewDecision,
  planReviewItemFromEvent,
  planReviewResponse
} from '../src/renderer/src/features/plan/lib/planReview'

const proposal = {
  title: 'Analysis plan',
  content: '# Analysis plan\n\n- Inspect data\n- Write report',
  planFilePath: 'local://analysis-plan.md'
}

const structuredPlan = {
  version: 1,
  goal: 'Publish the analysis',
  steps: [
    {
      id: 'inspect',
      title: 'Inspect source data',
      instructions: 'Read the source files and note anomalies.',
      acceptance: 'Anomalies are documented.',
      dependsOn: [],
      access: 'read',
      agent: 'explore'
    },
    {
      id: 'write-report',
      title: 'Write report',
      instructions: 'Write the final report.',
      acceptance: 'The report is saved.',
      dependsOn: ['inspect'],
      access: 'write',
      writes: ['report.md']
    }
  ]
} satisfies PlanSpec

setUiLanguage('zh-CN')

test('plan review panel renders the proposal and both decisions', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(UserInteractionPanel, {
        request: { requestId: 'review-1', questions: [], planReview: proposal },
        onRespond: () => undefined
      })
    )
  )
  assert.match(markup, /aria-label="计划等待评审"/)
  assert.match(markup, /Inspect data/)
  assert.match(markup, /批准并开始执行/)
  assert.match(markup, /修改计划/)
  assert.match(markup, /工作区/)
  assert.doesNotMatch(markup, /data-phi-plan-steps/)
})

test('plan review panel shows structured steps with folded details', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(UserInteractionPanel, {
        request: {
          requestId: 'review-steps',
          questions: [],
          planReview: { ...proposal, steps: structuredPlan }
        },
        onRespond: () => undefined
      })
    )
  )
  assert.match(markup, /data-phi-plan-steps="true"/)
  assert.match(markup, /1\. Inspect source data/)
  assert.match(markup, /2\. Write report/)
  assert.match(markup, /读/)
  assert.match(markup, /写/)
  assert.match(markup, /依赖第 1 步/)
  assert.match(markup, /智能体：explore/)
  assert.match(markup, /说明与完成标准/)
  assert.match(markup, /Read the source files and note anomalies\./)
  assert.match(markup, /Anomalies are documented\./)
  assert.doesNotMatch(markup, /<details[^>]*\sopen(?:=|\s|>)/)
})

test('plan review responses keep approval and requested changes distinct', () => {
  assert.deepEqual(planReviewResponse('review-1', 'approve'), {
    requestId: 'review-1',
    answers: [{ questionIndex: 0, question: 'plan_review', kind: 'option', answer: 'approve' }]
  })
  assert.deepEqual(planReviewResponse('review-1', 'revise', '  Add a validation step  '), {
    requestId: 'review-1',
    answers: [{ questionIndex: 0, question: 'plan_review', kind: 'option', answer: 'revise' }],
    globalNote: 'Add a validation step'
  })
})

test('plan timeline keeps one durable card and updates its decision', () => {
  const item = planReviewItemFromEvent({
    type: 'plan_review_submitted',
    eventId: 'event-1',
    reviewId: 'review-1',
    runId: 'run-1',
    ...proposal
  })
  assert.ok(item)
  const items = [item]
  assert.equal(
    applyPlanReviewDecision(items, {
      type: 'plan_review_decided',
      reviewId: 'review-1',
      decision: 'revise',
      note: 'Add a validation step'
    }),
    true
  )
  assert.equal(items.length, 1)
  assert.equal(items[0].status, 'revise')
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanReviewCard, { item: items[0], cwd: '/workspace' })
    )
  )
  assert.match(markup, /aria-label="计划评审记录"/)
  assert.match(markup, /需要修改/)
  assert.match(markup, /Inspect data/)
  assert.match(markup, /Add a validation step/)
  assert.doesNotMatch(markup, /data-phi-plan-steps/)
})

test('plan timeline card restores and renders structured steps', () => {
  const item = planReviewItemFromEvent({
    type: 'plan_review_submitted',
    eventId: 'event-steps',
    reviewId: 'review-steps',
    ...proposal,
    steps: structuredPlan
  })
  assert.ok(item)
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanReviewCard, { item, cwd: '/workspace' })
    )
  )
  assert.match(markup, /data-phi-plan-steps="true"/)
  assert.match(markup, /1\. Inspect source data/)
  assert.match(markup, /2\. Write report/)
  assert.match(markup, /依赖第 1 步/)
  assert.match(markup, /智能体：explore/)
  assert.match(markup, /data-phi-plan-step-details="inspect"/)
  assert.doesNotMatch(markup, /<details[^>]*\sopen(?:=|\s|>)/)
})

test('plan review copy follows live language changes', () => {
  const item = planReviewItemFromEvent({
    type: 'plan_review_submitted',
    reviewId: 'review-language',
    ...proposal,
    steps: structuredPlan
  })
  assert.ok(item)
  const view = createElement(
    ThemeProvider,
    { theme: createTheme() },
    createElement(PlanReviewCard, { item, cwd: '/workspace' })
  )
  setUiLanguage('en')
  const english = renderToStaticMarkup(view)
  setUiLanguage('zh-CN')
  const chinese = renderToStaticMarkup(view)
  assert.match(english, /aria-label="Plan review history"/)
  assert.match(english, /Depends on step 1/)
  assert.match(chinese, /aria-label="计划评审记录"/)
  assert.match(chinese, /依赖第 1 步/)
})
