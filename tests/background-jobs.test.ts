import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import type { BackgroundAgentJob } from '../src/shared/backgroundJobTypes'
import type { WrapperRun } from '../src/shared/wrapperTypes'
import { BackgroundJobsPanel } from '../src/renderer/src/features/jobs/BackgroundJobsPanel'
import {
  canStopUnifiedWrapperRun,
  selectBackgroundJobs
} from '../src/renderer/src/features/jobs/lib/backgroundJobs'

const agent: BackgroundAgentJob = {
  agentSessionId: 'runtime-1',
  agentRunId: 'agent-1',
  sessionId: 'session-1',
  sessionPath: 'phi-session:session-1',
  sessionTitle: 'Analyze samples',
  agentName: 'Database',
  task: 'Search metadata',
  state: 'running',
  background: true,
  startedAt: '2026-09-27T10:00:00.000Z',
  lastStep: 'db_query'
}

function wrapper(overrides: Partial<WrapperRun> = {}): WrapperRun {
  return {
    runId: 'wrun_1',
    planId: 'plan-1',
    revision: 1,
    state: 'running',
    actor: 'user',
    wrapper: {
      canonicalId: 'phi/ngs/fastq-qc',
      namespace: 'phi/ngs',
      shortId: 'fastq-qc',
      version: '1.0.0'
    },
    trustTier: 'bundled',
    executor: 'local',
    profile: 'local',
    cwd: '/project',
    outDir: '/project/results',
    createdAt: '2026-09-27T10:00:00.000Z',
    updatedAt: '2026-09-27T10:01:00.000Z',
    ...overrides
  } as WrapperRun
}

test('job overview combines live Agent and Wrapper runs and caps recent results', () => {
  const result = selectBackgroundJobs(
    [
      agent,
      { ...agent, agentRunId: 'agent-2', state: 'done', completedAt: '2026-09-27T10:05:00.000Z' },
      { ...agent, agentRunId: 'foreground', background: false }
    ],
    [
      wrapper({ runId: 'wrun_1' }),
      wrapper({ runId: 'wrun_2', state: 'failed', updatedAt: '2026-09-27T10:06:00.000Z' })
    ],
    1
  )
  assert.deepEqual(
    result.active.map((item) => item.key),
    ['wrapper:wrun_1', 'agent:runtime-1:agent-1']
  )
  assert.deepEqual(
    result.recent.map((item) => item.key),
    ['wrapper:wrun_2']
  )
})

test('job overview uses the existing cancellation policy for Wrapper runs', () => {
  assert.equal(canStopUnifiedWrapperRun(wrapper({ origin: 'composition' })), true)
  assert.equal(canStopUnifiedWrapperRun(wrapper({ state: 'queued' })), true)
  assert.equal(canStopUnifiedWrapperRun(wrapper({ executor: 'slurm-controller' })), true)
  assert.equal(canStopUnifiedWrapperRun(wrapper({ state: 'running', executor: 'local' })), false)
  assert.equal(canStopUnifiedWrapperRun(wrapper({ state: 'completed' })), false)
})

test('right sidebar job panel is available even when no job is running', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(BackgroundJobsPanel, {
        onOpenSession: () => undefined,
        onOpenWrapper: () => undefined
      })
    )
  )
  assert.match(markup, /data-phi-background-jobs-panel="true"/)
  assert.match(markup, /后台任务 · 0 个进行中/)
  assert.doesNotMatch(markup, /aria-expanded=/)
  const activityBarSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/AppActivityBar.tsx'),
    'utf8'
  )
  assert.doesNotMatch(activityBarSource, /<BackgroundJobsPanel/)
})
