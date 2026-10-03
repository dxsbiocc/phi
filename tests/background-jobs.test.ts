import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import type { BackgroundAgentJob } from '../src/shared/backgroundJobTypes'
import type { EnvironmentBuild } from '../src/shared/environmentBuildTypes'
import type { WrapperRun } from '../src/shared/wrapperTypes'
import { BackgroundJobsPanel } from '../src/renderer/src/features/jobs/BackgroundJobsPanel'
import {
  canStopUnifiedWrapperRun,
  environmentBuildDetail,
  environmentBuildPercent,
  environmentBuildTitle,
  selectBackgroundJobs
} from '../src/renderer/src/features/jobs/lib/backgroundJobs'

const agent: BackgroundAgentJob = {
  agentSessionId: 'runtime-1',
  agentRunId: 'agent-1',
  sessionId: 'session-1',
  sessionPath: 'phi-session:session-1',
  sessionTitle: 'Analyze samples',
  agentName: 'Wrapper',
  task: 'Run quality control',
  state: 'running',
  background: true,
  startedAt: '2026-09-27T10:00:00.000Z',
  lastStep: 'wrapper_run'
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
    [],
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

const MB = 1024 ** 2
const GB = 1024 ** 3

function environment(overrides: Partial<EnvironmentBuild> = {}): EnvironmentBuild {
  return {
    envId: 'env-1',
    ref: 'phi-python',
    state: 'building',
    phase: 'check',
    message: 'checking env-1',
    startedAt: '2026-09-27T10:00:00.000Z',
    estimate: { packages: 4, cachedPackages: 1 },
    progress: { packagesDone: 1, packages: 4 },
    ...overrides
  }
}

test('environment builds sort with agent and wrapper jobs and stay out of the active list once finished', () => {
  const result = selectBackgroundJobs(
    [
      agent,
      { ...agent, agentRunId: 'agent-2', state: 'done', completedAt: '2026-09-27T10:05:00.000Z' }
    ],
    [
      wrapper({ runId: 'wrun_1', updatedAt: '2026-09-27T10:01:00.000Z' }),
      wrapper({ runId: 'wrun_2', state: 'failed', updatedAt: '2026-09-27T10:02:00.000Z' })
    ],
    [
      environment({ envId: 'env-live', startedAt: '2026-09-27T10:03:00.000Z' }),
      environment({
        envId: 'env-done',
        state: 'ready',
        startedAt: '2026-09-27T09:00:00.000Z',
        finishedAt: '2026-09-27T10:04:00.000Z'
      })
    ],
    2
  )
  assert.deepEqual(
    result.active.map((item) => item.key),
    ['environment:env-live', 'wrapper:wrun_1', 'agent:runtime-1:agent-1']
  )
  assert.equal(result.active[0]?.kind, 'environment')
  assert.equal(result.active[0]?.active, true)
  assert.deepEqual(
    result.recent.map((item) => item.key),
    ['agent:runtime-1:agent-2', 'environment:env-done']
  )
  const cancelled = selectBackgroundJobs(
    [],
    [],
    [
      environment({
        envId: 'env-stop',
        state: 'cancelled',
        finishedAt: '2026-09-27T10:07:00.000Z'
      })
    ]
  )
  assert.deepEqual(cancelled.active, [])
  assert.equal(cancelled.recent[0]?.key, 'environment:env-stop')
  assert.equal(cancelled.recent[0]?.active, false)
  assert.deepEqual(
    selectBackgroundJobs([agent], []).active.map((item) => item.key),
    ['agent:runtime-1:agent-1']
  )
})

test('environment build copy names the ref, phase, package count, and byte progress', () => {
  assert.equal(environmentBuildTitle(environment()), '构建环境 phi-python')
  const phases: Array<[string, string]> = [
    ['check', '检查'],
    ['wait', '等待包缓存'],
    ['create', '下载安装包'],
    ['source-packages', '安装源码包'],
    ['activation', '激活'],
    ['finalize', '收尾'],
    ['done', '完成'],
    ['failed', '失败'],
    ['cancelled', '已取消']
  ]
  for (const [phase, label] of phases) {
    assert.equal(environmentBuildDetail(environment({ phase })), `构建中 · ${label} · 1/4 个包`)
  }
  assert.equal(
    environmentBuildDetail(environment({ phase: 'compile' })),
    '构建中 · compile · 1/4 个包'
  )
  assert.equal(
    environmentBuildDetail(
      environment({
        state: 'failed',
        phase: 'create',
        error: 'solver failed',
        progress: { packagesDone: 1, packages: 4, bytesDone: 1.5 * MB, bytesTotal: 10 * MB }
      })
    ),
    '失败 · 下载安装包 · 1/4 个包 · 1.5 MB / 10.0 MB · solver failed'
  )
  assert.equal(
    environmentBuildDetail(
      environment({
        state: 'ready',
        phase: 'done',
        progress: { packagesDone: 2, packages: 2, bytesDone: 1.5 * GB, bytesTotal: 2 * GB }
      })
    ),
    '已就绪 · 完成 · 2/2 个包 · 1.5 GB / 2.0 GB'
  )
  assert.equal(
    environmentBuildDetail(
      environment({
        state: 'building',
        phase: 'create',
        progress: { packagesDone: 1, packages: 4, bytesDone: MB, bytesTotal: GB - MB }
      })
    ),
    '构建中 · 下载安装包 · 1/4 个包 · 1.0 MB / 1023.0 MB'
  )
  const cancelled = environmentBuildDetail(
    environment({
      state: 'cancelled',
      phase: 'cancelled',
      error: 'environment build cancelled'
    })
  )
  assert.equal(cancelled, '已取消 · 已取消 · 1/4 个包')
  assert.doesNotMatch(cancelled, /environment build cancelled/)
})

test('environment build percent uses bytes when known, otherwise packages', () => {
  assert.equal(
    environmentBuildPercent(
      environment({
        progress: { packagesDone: 1, packages: 8, bytesDone: MB, bytesTotal: 4 * MB }
      })
    ),
    25
  )
  assert.equal(
    environmentBuildPercent(environment({ progress: { packagesDone: 1, packages: 4 } })),
    25
  )
  assert.equal(
    environmentBuildPercent(environment({ progress: { packagesDone: 0, packages: 0 } })),
    undefined
  )
  assert.equal(
    environmentBuildPercent(
      environment({
        progress: { packagesDone: 3, packages: 4, bytesDone: 5 * GB, bytesTotal: 2 * GB }
      })
    ),
    100
  )
  assert.equal(
    environmentBuildPercent(
      environment({
        progress: { packagesDone: 1, packages: 4, bytesDone: 0, bytesTotal: 0 }
      })
    ),
    25
  )
})
