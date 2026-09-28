import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import UserInteractionPanel from '../src/renderer/src/components/UserInteractionPanel'
import { PlanReviewCard } from '../src/renderer/src/features/chat/components/PlanReviewCard'
import {
  applyPlanReviewDecision,
  planReviewItemFromEvent,
  planReviewResponse
} from '../src/renderer/src/features/chat/lib/planReview'

const proposal = {
  title: 'Analysis plan',
  content: '# Analysis plan\n\n- Inspect data\n- Write report',
  planFilePath: 'local://analysis-plan.md'
}

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
  assert.match(markup, /继续执行/)
  assert.match(markup, /修改计划/)
  assert.match(markup, /工作区/)
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
  assert.match(markup, /Add a validation step/)
})
