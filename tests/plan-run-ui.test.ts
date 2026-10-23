import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import type { PlanRunTimelineSnapshot } from '../src/shared/planRunTypes'
import { PlanRunPanel } from '../src/renderer/src/features/plan/PlanRunPanel'
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
  assert.match(markup, /尝试 2 次/)
  assert.match(markup, /aria-label="重试"/)
  assert.match(markup, /aria-label="跳过"/)
  assert.match(markup, /aria-label="停止"/)
})
