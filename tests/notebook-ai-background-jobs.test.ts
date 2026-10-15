import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material'

import type { NotebookAiGenerationJob } from '../src/shared/notebookAiJobTypes'
import { BackgroundJobDetail } from '../src/renderer/src/features/jobs/components/BackgroundJobDetail'
import { BackgroundJobRow } from '../src/renderer/src/features/jobs/components/BackgroundJobRow'
import { JobDetailField } from '../src/renderer/src/features/jobs/components/JobDetailField'
import { BackgroundJobHistory } from '../src/renderer/src/features/jobs/lib/backgroundJobHistory'
import {
  canStopJob,
  jobDetail,
  jobDetailFields,
  jobPercent,
  jobSource,
  jobStatus,
  jobTitle
} from '../src/renderer/src/features/jobs/lib/backgroundJobLabels'
import { selectBackgroundJobs } from '../src/renderer/src/features/jobs/lib/backgroundJobs'
import {
  LATEST_JUPYTER_JOB_KEY,
  notebookAiJobRequestKey,
  resolveRequestedBackgroundJobKey,
  resolveSelectedBackgroundJob
} from '../src/renderer/src/features/jobs/lib/requestedBackgroundJob'

const startedAt = '2026-10-15T10:00:00.000Z'
const completedAt = '2026-10-15T10:01:00.000Z'

function job(overrides: Partial<NotebookAiGenerationJob> = {}): NotebookAiGenerationJob {
  return {
    id: 'attempt-1',
    requestId: 'draft-1',
    projectCwd: '/project',
    notebookPath: '/project/analysis.ipynb',
    notebookName: 'analysis.ipynb',
    model: 'provider/model',
    prompt: 'PRIVATE_PROMPT: summarize expression',
    state: 'running',
    phase: 'waiting',
    startedAt,
    updatedAt: startedAt,
    ...overrides
  }
}

function select(jobs: NotebookAiGenerationJob[]): ReturnType<typeof selectBackgroundJobs> {
  return selectBackgroundJobs([], [], {}, [], [], [], [], [], jobs)
}

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

test('Notebook generation attempts join active and completed tasks independently from their draft', () => {
  const jobs = select([
    job(),
    job({ id: 'attempt-0', state: 'failed', phase: 'failed', completedAt }),
    job({ id: 'attempt-2', state: 'completed', phase: 'completed', completedAt, cellCount: 2 })
  ])
  assert.deepEqual(
    jobs.active.map((item) => item.key),
    ['notebook-ai:attempt-1']
  )
  assert.equal(jobs.recent.length, 2)
  assert.equal(new Set([...jobs.active, ...jobs.recent].map((item) => item.key)).size, 3)
  const filtered = selectBackgroundJobs(
    [],
    [],
    { finishedAfter: '2026-10-15T10:02:00.000Z' },
    [],
    [],
    [],
    [],
    [],
    [job(), job({ id: 'old', state: 'completed', phase: 'completed', completedAt })]
  )
  assert.equal(filtered.active.length, 1)
  assert.equal(filtered.recent.length, 0)
})

test('Notebook tasks show readable phases, elapsed time and real completion or error details', () => {
  const [active] = select([job()]).active
  assert.ok(active)
  assert.equal(jobTitle(active), 'AI 生成 · analysis.ipynb')
  assert.equal(jobSource(active), 'Notebook AI')
  assert.equal(jobStatus(active).tone, 'running')
  assert.equal(canStopJob(active), false)
  assert.equal(jobPercent(active), undefined)
  const phases = {
    preparing: '准备上下文',
    waiting: '等待模型响应',
    generating: '正在生成代码',
    repairing: '修正生成结果'
  } as const
  for (const [phase, label] of Object.entries(phases)) {
    const [item] = select([job({ phase: phase as NotebookAiGenerationJob['phase'] })]).active
    assert.match(jobDetail(item, Date.parse(completedAt)), new RegExp(label))
  }
  assert.match(jobDetail(active, Date.parse(completedAt)), /1 分钟 0 秒/)
  const [done] = select([
    job({
      state: 'completed',
      phase: 'completed',
      completedAt,
      cellCount: 3,
      sourcePreview: 'df.head()'
    })
  ]).recent
  assert.equal(jobStatus(done).tone, 'success')
  assert.match(jobDetail(done, Date.parse('2026-10-15T11:00:00.000Z')), /1 分钟 0 秒.*3 个单元/)
  const fields = Object.fromEntries(
    jobDetailFields(done, Date.parse(completedAt)).map((field) => [field.label, field.value])
  )
  assert.equal(fields.Notebook, '/project/analysis.ipynb')
  assert.equal(fields.项目, '/project')
  assert.equal(fields.模型, 'provider/model')
  assert.equal(fields.请求, 'PRIVATE_PROMPT: summarize expression')
  assert.equal(fields.代码预览, 'df.head()')
  assert.ok(fields.开始时间)
  assert.ok(fields.结束时间)
  const [failed] = select([
    job({ state: 'failed', phase: 'failed', completedAt, error: 'Provider unavailable' })
  ]).recent
  assert.equal(jobStatus(failed).tone, 'error')
  assert.match(jobDetail(failed, Date.parse(completedAt)), /生成失败.*Provider unavailable/)
  assert.equal(
    jobDetailFields(failed, Date.parse(completedAt)).find((field) => field.label === '错误')?.value,
    'Provider unavailable'
  )
})

test('Notebook rows open details without stop, retry, a made-up progress bar or conversation navigation', () => {
  const [item] = select([job({ sourcePreview: 'import pandas as pd' })]).active
  const common = { item, nowMs: Date.parse(completedAt), busy: false, onStop: () => undefined }
  const row = render(createElement(BackgroundJobRow, { ...common, onOpen: () => undefined }))
  const detail = render(
    createElement(BackgroundJobDetail, {
      ...common,
      onBack: () => undefined,
      onOpenSession: () => undefined
    })
  )
  assert.match(row, /查看 AI 生成 · analysis.ipynb 详情/)
  assert.match(detail, /等待模型响应/)
  assert.match(detail, /import pandas as pd/)
  assert.doesNotMatch(row + detail, /打开对话|停止这个|aria-label="停止|role="progressbar"|>重试</)
})

test('saved Notebook paths use the panel font while code fields stay monospaced', () => {
  const path = render(
    createElement(JobDetailField, {
      label: 'Notebook',
      value: '/project/notebooks/analysis.ipynb',
      mono: true
    })
  )
  const code = render(
    createElement(JobDetailField, { label: '代码预览', value: 'print(1)', mono: true })
  )

  assert.doesNotMatch(path, /font-family:var\(--font-mono\)/)
  assert.match(code, /font-family:var\(--font-mono\)/)
})

test('Notebook task history retains bounded metadata but never persists prompts, generated code or errors', () => {
  let value: string | null = null
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next
    }
  }
  const jobs = select([
    job({
      state: 'completed',
      phase: 'completed',
      completedAt,
      cellCount: 3,
      sourcePreview: 'PRIVATE_SOURCE'
    }),
    job({ id: 'attempt-2', state: 'failed', phase: 'failed', completedAt, error: 'PRIVATE_ERROR' })
  ])
  const history = new BackgroundJobHistory(storage)
  history.observe(jobs.recent)
  assert.ok(value)
  assert.doesNotMatch(value, /PRIVATE_|prompt|sourcePreview|requestId/)
  const restored = new BackgroundJobHistory(storage).select({ active: [], recent: [] }).recent
  assert.equal(restored.length, 2)
  assert.ok(
    restored.every((item) => item.kind === 'history' && item.snapshot.sourceKind === 'notebook-ai')
  )
  const done = restored.find((item) => item.key === 'notebook-ai:attempt-1')!
  const fields = jobDetailFields(done, Date.parse(completedAt))
  assert.ok(fields.some((field) => field.label === '生成单元' && field.value === '3 个单元'))
  assert.ok(fields.some((field) => field.label === '模型' && field.value === 'provider/model'))
  assert.equal(canStopJob(done), false)
  history.clearCompleted(jobs.recent, '2026-10-15T10:02:00.000Z')
  assert.equal(new BackgroundJobHistory(storage).select(jobs).recent.length, 0)
  const retry = select([
    job({
      id: 'attempt-3',
      state: 'completed',
      phase: 'completed',
      completedAt: '2026-10-15T10:03:00.000Z'
    })
  ])
  history.observe(retry.recent)
  assert.equal(
    new BackgroundJobHistory(storage).select({ active: [], recent: [] }).recent[0].key,
    'notebook-ai:attempt-3'
  )
})

test('an early Notebook task request remains unresolved until polling finds its newest attempt', () => {
  const key = notebookAiJobRequestKey('draft-1')
  assert.equal(key, 'notebook-ai-request:draft-1')
  assert.equal(
    resolveRequestedBackgroundJobKey(key, { jupyterJobs: [], notebookAiJobs: [] }, []),
    undefined
  )
  const older = job({ id: 'older', state: 'failed', phase: 'failed', completedAt })
  const latest = job({ id: 'latest', startedAt: '2026-10-15T10:02:00.000Z' })
  const data = {
    jupyterJobs: [],
    notebookAiJobs: [
      older,
      latest,
      job({ id: 'unrelated', requestId: 'draft-2', startedAt: '2026-10-15T11:00:00.000Z' })
    ]
  }
  assert.equal(resolveRequestedBackgroundJobKey(key, data, []), 'notebook-ai:latest')
  assert.equal(resolveRequestedBackgroundJobKey('shell:existing', data, []), 'shell:existing')
  assert.equal(resolveRequestedBackgroundJobKey(LATEST_JUPYTER_JOB_KEY, data, []), undefined)
  assert.equal(
    resolveRequestedBackgroundJobKey(
      key,
      { jupyterJobs: [], notebookAiJobs: [latest, { ...latest, id: 'same-ms-older' }] },
      []
    ),
    'notebook-ai:latest'
  )
})

test('an explicit Notebook request opens a cleared completion without restoring its tray row', () => {
  const completed = job({ state: 'completed', phase: 'completed', completedAt, cellCount: 2 })
  const live = select([completed])
  const history = new BackgroundJobHistory()
  history.observe(live.recent)
  history.clearCompleted(live.recent, '2026-10-15T10:02:00.000Z')
  const visible = history.select(live)
  assert.deepEqual(visible, { active: [], recent: [] })
  const selectedKey = resolveRequestedBackgroundJobKey(
    notebookAiJobRequestKey(completed.requestId),
    { jupyterJobs: [], notebookAiJobs: [completed] },
    visible.recent
  )
  assert.equal(selectedKey, 'notebook-ai:attempt-1')
  const detail = resolveSelectedBackgroundJob(selectedKey!, [], [completed])
  assert.ok(detail)
  assert.equal(detail.kind, 'notebook-ai')
  assert.equal(jobStatus(detail).label, '已完成')
  assert.ok(
    jobDetailFields(detail, Date.parse(completedAt)).some(
      (field) => field.label === '生成单元' && field.value === '2 个单元'
    )
  )
  assert.deepEqual(history.select(live), { active: [], recent: [] })
  assert.equal(resolveSelectedBackgroundJob(null, [], [completed]), undefined)
  assert.equal(resolveSelectedBackgroundJob('notebook-ai:absent', [], [completed]), undefined)
  assert.equal(resolveSelectedBackgroundJob('shell:absent', [], [completed]), undefined)
  assert.equal(
    resolveSelectedBackgroundJob(live.recent[0].key, live.recent, [completed]),
    live.recent[0]
  )
})
