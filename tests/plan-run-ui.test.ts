import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { GoCircleSlash, GoIssueDraft, GoPlay, GoRocket, GoSkip, GoUnverified } from 'react-icons/go'

import type { PlanRunTimelineSnapshot } from '../src/shared/planRunTypes'
import { PLAN_MAX_REPLANS } from '../src/shared/planRunTypes'
import { PlanRunPanel, PlanRunRecord } from '../src/renderer/src/features/plan/PlanRunPanel'
import { PlanReviewCard } from '../src/renderer/src/features/plan/components/PlanReviewCard'
import type { PlanRunsController } from '../src/renderer/src/features/plan/hooks/usePlanRuns'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

const run: PlanRunTimelineSnapshot = {
  id: 'plan-1',
  status: 'paused',
  pause: { reason: 'step_failed', stepId: 'write' },
  replans: 0,
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:05.000Z',
  goal: 'Ship the renderer loop',
  steps: [
    {
      id: 'read',
      title: 'Inspect code',
      access: 'read',
      dependsOn: [],
      status: 'done',
      attempts: 1,
      missingInputs: []
    },
    {
      id: 'write',
      title: 'Implement panel',
      access: 'write',
      dependsOn: ['read'],
      status: 'failed',
      attempts: 2,
      missingInputs: [],
      error: 'Typecheck failed'
    }
  ]
}

function controller(): PlanRunsController {
  return {
    run,
    details: null,
    loading: false,
    pendingAction: null,
    error: null,
    loadDetails: async () => null,
    pause: async () => undefined,
    resume: async () => undefined,
    stop: async () => undefined,
    retryStep: async () => undefined,
    skipStep: async () => undefined
  }
}

test('approved review and active run show each step only in the run panel', () => {
  setUiLanguage('zh-CN')
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(
        'div',
        null,
        createElement(PlanReviewCard, {
          item: {
            id: 'review-1',
            role: 'plan_review',
            reviewId: 'review-1',
            title: run.goal,
            content: '# Plan\n\n- Inspect code\n- Implement panel',
            planFilePath: 'local://PLAN.md',
            status: 'approved'
          },
          cwd: '/workspace'
        }),
        createElement(PlanRunPanel, { controller: controller(), cwd: '/workspace' })
      )
    )
  )
  assert.match(markup, /计划 · Ship the renderer loop/)
  assert.match(markup, /已批准/)
  assert.match(markup, /<details[^>]*data-phi-plan-review-details="true"[^>]*>/)
  assert.doesNotMatch(
    markup,
    /<details[^>]*data-phi-plan-review-details="true"[^>]*\sopen(?:=|\s|>)/
  )
  assert.equal(markup.match(/>1\. Inspect code</g)?.length, 1)
  assert.equal(markup.match(/>2\. Implement panel</g)?.length, 1)
})

test('plan run panel renders progress, pause reason and recovery actions', () => {
  setUiLanguage('zh-CN')
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, { controller: controller(), cwd: '/workspace' })
    )
  )
  assert.match(markup, /Ship the renderer loop/)
  assert.match(markup, /1\/2 完成/)
  assert.match(markup, /第 2 步失败/)
  assert.match(markup, /Implement panel/)
  const titleAt = markup.indexOf('Implement panel')
  const accessAt = markup.indexOf('aria-label="写"', titleAt)
  const attemptsAt = markup.indexOf('尝试 2 次', titleAt)
  assert.ok(titleAt >= 0 && accessAt > titleAt && attemptsAt > accessAt)
  assert.match(markup, /尝试 2 次/)
  assert.match(markup, /data-phi-step-mark="failed"/)
  assert.match(markup, /aria-label="失败"/)
  assert.doesNotMatch(markup, />失败</)
  assert.match(markup, /aria-label="重试"/)
  assert.match(markup, /aria-label="跳过"/)
  assert.match(markup, /aria-label="停止"/)
  assert.doesNotMatch(markup, />已完成</)
})

test('a running plan uses the pause icon instead of a text label', () => {
  setUiLanguage('zh-CN')
  const running = {
    ...run,
    status: 'running' as const,
    pause: undefined,
    steps: run.steps.map((step) =>
      step.id === 'write' ? { ...step, status: 'running' as const } : step
    )
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, {
        controller: { ...controller(), run: running },
        cwd: '/workspace'
      })
    )
  )
  assert.match(markup, /aria-label="暂停"/)
  assert.doesNotMatch(markup, />暂停</)
})

test('a step that has not started uses the draft icon', () => {
  setUiLanguage('zh-CN')
  const pending = {
    ...run,
    status: 'running' as const,
    pause: undefined,
    steps: run.steps.map((step) =>
      step.id === 'write' ? { ...step, status: 'pending' as const, attempts: 0 } : step
    )
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, {
        controller: { ...controller(), run: pending },
        cwd: '/workspace'
      })
    )
  )
  const draftPath = renderToStaticMarkup(createElement(GoIssueDraft)).match(
    /<path d="([^"]+)"/
  )?.[1]
  assert.match(markup, /data-phi-step-mark="pending"/)
  assert.ok(draftPath && markup.includes(draftPath))
  assert.match(markup, /aria-label="待执行"/)
  assert.doesNotMatch(markup, />待执行</)
})

test('a user-paused plan resumes with the play icon', () => {
  setUiLanguage('zh-CN')
  const paused = {
    ...run,
    status: 'paused' as const,
    pause: { reason: 'user' as const },
    steps: run.steps.map((step) =>
      step.id === 'write' ? { ...step, status: 'pending' as const, attempts: 0 } : step
    )
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, {
        controller: { ...controller(), run: paused },
        cwd: '/workspace'
      })
    )
  )
  const playPath = renderToStaticMarkup(createElement(GoPlay)).match(/<path d="([^"]+)"/)?.[1]
  assert.match(markup, /aria-label="继续"/)
  assert.doesNotMatch(markup, />继续</)
  assert.ok(playPath && markup.includes(playPath))
})

test('restart interruption shows recovery actions and workspace check', () => {
  setUiLanguage('en')
  const interrupted = {
    ...run,
    pause: { reason: 'interrupted' as const, stepId: 'write' },
    steps: run.steps.map((step) =>
      step.id === 'write' ? { ...step, status: 'interrupted' as const } : step
    )
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, { controller: { ...controller(), run: interrupted } })
    )
  )
  assert.match(markup, /Interrupted by app restart/)
  assert.match(markup, /data-phi-step-mark="interrupted"/)
  assert.match(markup, /aria-label="Interrupted"/)
  assert.doesNotMatch(markup, />Interrupted</)
  assert.match(markup, /Check any workspace changes before retrying/)
  assert.match(markup, /aria-label="Retry"/)
  assert.match(markup, /aria-label="Skip"/)
})

test('missing inputs remain visible without promising retry supplies them', () => {
  setUiLanguage('zh-CN')
  const needsInput = {
    ...run,
    pause: { reason: 'needs_input' as const, stepId: 'write' },
    steps: run.steps.map((step) =>
      step.id === 'write' ? { ...step, missingInputs: ['目标受众', '输出格式'] } : step
    )
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, { controller: { ...controller(), run: needsInput } })
    )
  )
  assert.match(markup, /目标受众/)
  assert.match(markup, /输出格式/)
  assert.match(markup, /重试仍使用原有步骤说明，不会提交缺少的信息/)
})

test('unknown launch explains the safety hold in English and hides all recovery controls', () => {
  setUiLanguage('en')
  const unknown = {
    ...run,
    pause: { reason: 'unknown' as const, stepId: 'write' },
    steps: run.steps.map((step) =>
      step.id === 'write' ? { ...step, status: 'unknown' as const } : step
    )
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, {
        controller: { ...controller(), run: unknown, replan: async () => undefined }
      })
    )
  )
  assert.match(markup, /Launch unconfirmed/)
  assert.match(markup, /may have started, but its launch could not be confirmed/)
  assert.match(markup, /Retry, skip, replan, and stop are unavailable/)
  assert.doesNotMatch(markup, /aria-label="Retry"/)
  assert.doesNotMatch(markup, /aria-label="Skip"/)
  assert.doesNotMatch(markup, /aria-label="Stop"/)
  assert.doesNotMatch(markup, /aria-label="Replan remaining steps"/)
})

test('launching and unknown have distinct Chinese statuses', () => {
  setUiLanguage('zh-CN')
  const launching = {
    ...run,
    status: 'running' as const,
    pause: undefined,
    steps: run.steps.map((step) =>
      step.id === 'write' ? { ...step, status: 'launching' as const } : step
    )
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, { controller: { ...controller(), run: launching } })
    )
  )
  assert.match(markup, /aria-label="正在启动智能体"/)
  assert.doesNotMatch(markup, />正在启动智能体</)
  const rocketPath = renderToStaticMarkup(createElement(GoRocket)).match(/<path d="([^"]+)"/)?.[1]
  assert.ok(rocketPath && markup.includes(rocketPath))
  assert.doesNotMatch(markup, /aria-label="停止"/)
  const unknown = {
    ...run,
    pause: { reason: 'unknown' as const, stepId: 'write' },
    steps: run.steps.map((step) =>
      step.id === 'write' ? { ...step, status: 'unknown' as const } : step
    )
  }
  const unknownMarkup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, { controller: { ...controller(), run: unknown } })
    )
  )
  assert.match(unknownMarkup, /aria-label="启动状态未确认"/)
  assert.doesNotMatch(unknownMarkup, />启动状态未确认</)
  const unverifiedPath = renderToStaticMarkup(createElement(GoUnverified)).match(
    /<path d="([^"]+)"/
  )?.[1]
  assert.ok(unverifiedPath && unknownMarkup.includes(unverifiedPath))
  assert.match(unknownMarkup, /确认安全前，不能重试、跳过、重新规划或停止/)
})

test('skipped and cancelled steps use different icons', () => {
  setUiLanguage('zh-CN')
  const mixed = {
    ...run,
    steps: [
      { ...run.steps[0]!, status: 'skipped' as const },
      { ...run.steps[1]!, status: 'cancelled' as const }
    ]
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, {
        controller: { ...controller(), run: mixed },
        cwd: '/workspace'
      })
    )
  )
  const skipPath = renderToStaticMarkup(createElement(GoSkip)).match(/<path d="([^"]+)"/)?.[1]
  const cancelPath = renderToStaticMarkup(createElement(GoCircleSlash)).match(
    /<path d="([^"]+)"/
  )?.[1]
  assert.ok(skipPath && cancelPath && skipPath !== cancelPath)
  assert.ok(markup.includes(skipPath) && markup.includes(cancelPath))
  assert.match(markup, /aria-label="已跳过"/)
  assert.match(markup, /aria-label="已取消"/)
  assert.doesNotMatch(markup, />已跳过</)
  assert.doesNotMatch(markup, />已取消</)
})

test('an unknown parallel launch holds controls even when an earlier step failed', () => {
  setUiLanguage('en')
  const mixed = {
    ...run,
    steps: [
      ...run.steps,
      {
        ...run.steps[0]!,
        id: 'parallel',
        title: 'Parallel step',
        status: 'unknown' as const
      }
    ]
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, {
        controller: { ...controller(), run: mixed, replan: async () => undefined }
      })
    )
  )
  assert.match(markup, /Step 2 failed/)
  assert.match(markup, /Another step has an unconfirmed launch/)
  assert.doesNotMatch(markup, /aria-label="Retry"/)
  assert.doesNotMatch(markup, /aria-label="Skip"/)
  assert.doesNotMatch(markup, /aria-label="Stop"/)
  assert.doesNotMatch(markup, /aria-label="Replan remaining steps"/)
})

test('replan is offered for a paused problem only when supported and under the limit', () => {
  setUiLanguage('en')
  const render = (snapshot: PlanRunTimelineSnapshot, replan?: () => Promise<void>): string =>
    renderToStaticMarkup(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(PlanRunPanel, { controller: { ...controller(), run: snapshot, replan } })
      )
    )
  assert.match(
    render(run, async () => undefined),
    /aria-label="Replan remaining steps"/
  )
  assert.match(
    render(run, async () => undefined),
    /draft revised steps for your review/
  )
  assert.doesNotMatch(render(run), /aria-label="Replan remaining steps"/)
  assert.doesNotMatch(
    render({ ...run, replans: PLAN_MAX_REPLANS }, async () => undefined),
    /aria-label="Replan remaining steps"/
  )
  const concurrentlyRunning = {
    ...run,
    steps: [...run.steps, { ...run.steps[0]!, id: 'parallel', status: 'running' as const }]
  }
  assert.doesNotMatch(
    render(concurrentlyRunning, async () => undefined),
    /aria-label="Replan remaining steps"/
  )
  const cleanupPending = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, {
        controller: {
          ...controller(),
          replan: async () => undefined,
          rollbackPending: true,
          retryCancellation: async () => undefined
        }
      })
    )
  )
  assert.match(cleanupPending, /aria-label="Retry cancellation"/)
  assert.doesNotMatch(cleanupPending, /aria-label="Replan remaining steps"/)
})

test('pending replan keeps the timeline visible but disables old-run recovery controls', () => {
  setUiLanguage('en')
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, {
        controller: { ...controller(), replanPending: true, replan: async () => undefined }
      })
    )
  )
  assert.match(markup, /Ship the renderer loop/)
  assert.match(markup, /draft revised steps for your review/)
  assert.doesNotMatch(markup, /aria-label="Replan remaining steps"/)
  for (const label of ['Retry', 'Skip', 'Stop']) {
    const button = markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`, 'u'))?.[0]
    assert.ok(button, `${label} action remains visible`)
    assert.match(button, /\bdisabled\b/u)
  }
})

test('finished plan has only its timeline record, without a second composer panel', () => {
  setUiLanguage('zh-CN')
  const completed = {
    ...run,
    status: 'completed' as const,
    pause: undefined,
    steps: run.steps.map((step) => ({ ...step, status: 'done' as const }))
  }
  const live = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, { controller: { ...controller(), run: completed } })
    )
  )
  assert.equal(live, '')
  const record = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunRecord, { run: completed })
    )
  )
  assert.match(record, /Ship the renderer loop/)
  assert.match(record, /2\/2 完成/)
  assert.match(record, />1\. Inspect code</)
  assert.match(record, />2\. Implement panel</)
})

test('a finished record shows each step report when the run details are loaded', () => {
  setUiLanguage('zh-CN')
  const completed = {
    ...run,
    status: 'completed' as const,
    pause: undefined,
    steps: run.steps.map((step) => ({
      ...step,
      status: 'done' as const,
      startedAt: '2026-10-23T00:00:00.000Z',
      finishedAt: '2026-10-23T00:00:05.000Z'
    }))
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PlanRunPanel, {
        archived: true,
        cwd: '/workspace',
        controller: {
          ...controller(),
          run: completed,
          details: {
            id: completed.id,
            sessionId: 'session-1',
            spec: {
              version: 1,
              goal: completed.goal,
              steps: [
                {
                  id: 'read',
                  title: 'Inspect code',
                  instructions: 'Look around.',
                  acceptance: 'The path is known.',
                  access: 'read',
                  dependsOn: []
                },
                {
                  id: 'write',
                  title: 'Implement panel',
                  instructions: 'List names.',
                  acceptance: 'Ten names are listed.',
                  access: 'write',
                  dependsOn: ['read']
                }
              ]
            },
            status: 'completed',
            pause: undefined,
            replans: 0,
            createdAt: completed.createdAt,
            updatedAt: completed.updatedAt,
            steps: {
              read: {
                status: 'done',
                attempts: 1,
                report: {
                  status: 'completed',
                  text: 'Found the boundary',
                  missingInputs: []
                }
              },
              write: {
                status: 'done',
                attempts: 1,
                report: { status: 'completed', text: 'Listed ten names', missingInputs: [] }
              }
            }
          }
        }
      })
    )
  )
  assert.match(markup, /Found the boundary/)
  assert.match(markup, /Listed ten names/)
  assert.doesNotMatch(markup, /正在加载/)
  assert.doesNotMatch(markup, />已完成</)
})
