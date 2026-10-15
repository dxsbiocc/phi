import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material'
import test from 'node:test'

import type { BackgroundAgentJob, BackgroundShellJob } from '../src/shared/backgroundJobTypes'
import type { EnvironmentBuild } from '../src/shared/environmentBuildTypes'
import type { McpConnectorSetupProgress } from '../src/shared/mcpConnectorCatalog'
import type { RemoteJupyterStartJob } from '../src/shared/remoteJupyterJobTypes'
import type { RemoteProjectUploadJob } from '../src/shared/remoteProjectUploadTypes'
import type { WrapperRun } from '../src/shared/wrapperTypes'
import {
  BackgroundJobHistory,
  BACKGROUND_JOB_HISTORY_KEY
} from '../src/renderer/src/features/jobs/lib/backgroundJobHistory'
import {
  selectBackgroundJobs,
  type LiveBackgroundJob
} from '../src/renderer/src/features/jobs/lib/backgroundJobs'
import { canStopJob, jobTitle } from '../src/renderer/src/features/jobs/lib/backgroundJobLabels'
import { BackgroundJobRow } from '../src/renderer/src/features/jobs/components/BackgroundJobRow'
import { BackgroundJobDetail } from '../src/renderer/src/features/jobs/components/BackgroundJobDetail'

class MemoryStorage {
  value: string | null = null
  writes = 0
  getItem(): string | null {
    return this.value
  }
  setItem(key: string, value: string): void {
    assert.equal(key, BACKGROUND_JOB_HISTORY_KEY)
    this.value = value
    this.writes += 1
  }
}
const start = '2026-10-15T10:00:00.000Z'
const end = '2026-10-15T10:01:00.000Z'

function agent(overrides: Partial<BackgroundAgentJob> = {}): BackgroundAgentJob {
  return {
    agentSessionId: 'runtime-1',
    agentRunId: 'run-1',
    sessionId: 'session-1',
    sessionPath: 'phi-session:session-1',
    sessionTitle: 'Sample analysis',
    agentName: 'Analyzer',
    task: 'PRIVATE_TASK_PROMPT',
    lastStep: 'PRIVATE_LAST_STEP',
    background: true,
    state: 'done',
    startedAt: start,
    completedAt: end,
    ...overrides
  }
}
function terminalJobs(): LiveBackgroundJob[] {
  const shell: BackgroundShellJob = {
    agentSessionId: 'runtime-1',
    jobId: 'shell-1',
    sessionId: 'session-1',
    sessionPath: 'phi-session:session-1',
    sessionTitle: 'Sample analysis',
    state: 'failed',
    command: 'PRIVATE_COMMAND_TOKEN',
    output: 'PRIVATE_SHELL_LOG',
    startedAt: start,
    completedAt: end
  }
  const build: EnvironmentBuild = {
    envId: 'env-1',
    ref: 'phi-python',
    state: 'failed',
    phase: 'failed',
    message: 'PRIVATE_BUILD_OUTPUT',
    error: 'PRIVATE_BUILD_ERROR',
    startedAt: start,
    finishedAt: end,
    estimate: { packages: 1, cachedPackages: 0 },
    progress: { packagesDone: 0, packages: 1 }
  }
  const setup: McpConnectorSetupProgress = {
    id: 'mail',
    kind: 'local-stdio',
    title: 'Mail',
    summary: 'PRIVATE_CONNECTOR_COMMAND',
    phase: 'failed',
    revision: 1,
    updatedAt: end,
    startedAt: start,
    error: 'PRIVATE_CONNECTOR_ERROR'
  }
  const upload: RemoteProjectUploadJob = {
    id: 'upload-1',
    status: 'completed',
    destinationDirectory: 'reads',
    totalFiles: 1,
    totalBytes: 10,
    bytesTransferred: 10,
    bytesPerSecond: 0,
    requiresConfirmation: false,
    confirmed: true,
    files: [
      {
        name: 'sample.fastq',
        localPath: 'PRIVATE_LOCAL_PATH',
        relativePath: 'sample.fastq',
        size: 10,
        sha256: 'a'.repeat(64),
        resolution: 'pending'
      }
    ],
    createdAt: Date.parse(start),
    updatedAt: Date.parse(end)
  }
  const jupyter: RemoteJupyterStartJob = {
    id: 'jupyter-1',
    projectId: 'project-1',
    projectName: 'GPU',
    serverLabel: 'cluster',
    state: 'ready',
    phase: '就绪',
    startedAt: start,
    finishedAt: end,
    entries: [{ at: end, kind: 'output', text: 'PRIVATE_JUPYTER_TOKEN' }]
  }
  const wrapper = {
    runId: 'wrun_1',
    planId: 'plan-1',
    revision: 1,
    state: 'completed',
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
    createdAt: start,
    updatedAt: end,
    completedAt: end,
    environmentError: 'PRIVATE_WRAPPER_ERROR',
    inputErrors: ['PRIVATE_INPUT'],
    launchDiagnostic: 'PRIVATE_LAUNCH',
    params: { token: 'PRIVATE_PARAM_TOKEN' }
  } as unknown as WrapperRun
  return selectBackgroundJobs(
    [agent()],
    [wrapper],
    {},
    [shell],
    [build],
    [setup],
    [upload],
    [jupyter]
  ).recent
}
function empty(): { active: LiveBackgroundJob[]; recent: LiveBackgroundJob[] } {
  return { active: [], recent: [] }
}
function render(element: React.ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

test('terminal metadata from all seven sources survives a real storage round-trip without raw content', () => {
  const storage = new MemoryStorage()
  const live = terminalJobs()
  const history = new BackgroundJobHistory(storage)
  history.observe(live)
  assert.equal(storage.writes, 1)
  history.observe(live)
  assert.equal(storage.writes, 1, 'unchanged polling does not rewrite storage')
  assert.doesNotMatch(storage.value!, /PRIVATE_|command|output|params|entries|task/)
  const restarted = new BackgroundJobHistory(storage)
  const restored = restarted.select(empty())
  assert.equal(restored.active.length, 0)
  assert.equal(restored.recent.length, 7)
  assert.ok(restored.recent.every((item) => item.kind === 'history' && !item.active))
  assert.deepEqual(
    new Set(restored.recent.map((item) => item.kind === 'history' && item.snapshot.sourceKind)),
    new Set(['agent', 'shell', 'wrapper', 'environment', 'connector', 'upload', 'jupyter'])
  )
  assert.equal(jobTitle(restored.recent.find((item) => item.key.startsWith('shell:'))!), '后台命令')
})

test('live source jobs replace retained snapshots and running attempts are never restored', () => {
  const storage = new MemoryStorage()
  const history = new BackgroundJobHistory(storage)
  const [finished] = selectBackgroundJobs([agent()], []).recent
  history.observe([finished])
  const active = selectBackgroundJobs([agent({ state: 'running', completedAt: undefined })], [])
  assert.deepEqual(history.select(active).recent, [])
  assert.equal(history.select(active).active[0], active.active[0])
  history.observe(active.active)
  assert.deepEqual(new BackgroundJobHistory(storage).select(empty()), empty())
  const live = selectBackgroundJobs([agent({ agentName: 'Updated source', state: 'error' })], [])
  history.observe(live.recent)
  assert.equal(history.select(live).recent.length, 1)
  assert.equal(history.select(live).recent[0], live.recent[0])
  assert.equal(
    jobTitle(new BackgroundJobHistory(storage).select(empty()).recent[0]),
    'Updated source'
  )
})

test('clear persists across restart, suppresses old authoritative records, and allows later attempts', () => {
  const storage = new MemoryStorage()
  const history = new BackgroundJobHistory(storage)
  const live = terminalJobs()
  history.observe(live)
  history.clearCompleted(live, '2026-10-15T10:02:00.000Z')
  const restarted = new BackgroundJobHistory(storage)
  restarted.observe(live)
  assert.deepEqual(restarted.select({ active: [], recent: live }).recent, [])
  assert.deepEqual(new BackgroundJobHistory(storage).select(empty()).recent, [])
  const next = selectBackgroundJobs([agent({ completedAt: '2026-10-15T10:03:00.000Z' })], [])
  restarted.observe(next.recent)
  assert.equal(restarted.select(next).recent.length, 1)
  const active = selectBackgroundJobs(
    [agent({ agentRunId: 'active', state: 'running', completedAt: undefined })],
    []
  )
  restarted.clearCompleted(active.active, '2026-10-15T10:04:00.000Z')
  assert.equal(restarted.select(active).active.length, 1)
})

test('history keeps at most 50 newest records and clear also hides source records beyond the visible cap', () => {
  const storage = new MemoryStorage()
  const history = new BackgroundJobHistory(storage)
  const live = selectBackgroundJobs(
    Array.from({ length: 70 }, (_, index) =>
      agent({
        agentRunId: `run-${index}`,
        completedAt: new Date(Date.parse(end) + index * 1000).toISOString()
      })
    ),
    [],
    { maxRecent: 100 }
  )
  history.observe(live.recent)
  const restarted = new BackgroundJobHistory(storage)
  assert.equal(restarted.select(empty()).recent.length, 50)
  assert.equal(restarted.select(empty()).recent[0].key, 'agent:runtime-1:run-69')
  restarted.clearCompleted(live.recent, '2026-10-15T10:05:00.000Z')
  assert.deepEqual(new BackgroundJobHistory(storage).select(live).recent, [])
})

test('future-clock dismissal remains durable through another clear without the source present', () => {
  const storage = new MemoryStorage()
  const history = new BackgroundJobHistory(storage)
  const live = selectBackgroundJobs([agent({ completedAt: '2026-10-15T11:00:00.000Z' })], [])
  history.observe(live.recent)
  history.clearCompleted(live.recent, '2026-10-15T10:02:00.000Z')
  new BackgroundJobHistory(storage).clearCompleted([], '2026-10-15T10:03:00.000Z')
  assert.deepEqual(new BackgroundJobHistory(storage).select(live).recent, [])
})

test('corrupt, disabled or oversized storage is tolerated and metadata has strict size and navigation bounds', () => {
  for (const value of [
    '{broken',
    JSON.stringify({ schema: 9, records: [] }),
    'x'.repeat(128 * 1024 + 1)
  ]) {
    const storage = new MemoryStorage()
    storage.value = value
    assert.deepEqual(new BackgroundJobHistory(storage).select(empty()), empty())
  }
  const disabled = new BackgroundJobHistory({
    getItem: () => {
      throw new Error('disabled')
    },
    setItem: () => {
      throw new Error('quota')
    }
  })
  disabled.observe(terminalJobs())
  assert.equal(disabled.select(empty()).recent.length, 7)
  disabled.clearCompleted([], '2026-10-15T10:02:00.000Z')
  assert.equal(disabled.select(empty()).recent.length, 0)
  const storage = new MemoryStorage()
  const history = new BackgroundJobHistory(storage)
  history.observe(
    selectBackgroundJobs(
      [
        agent({
          agentName: 'n'.repeat(10000),
          sessionTitle: 's'.repeat(10000),
          sessionPath: 'javascript:alert(1)'
        })
      ],
      []
    ).recent
  )
  const [item] = new BackgroundJobHistory(storage).select(empty()).recent
  assert.equal(jobTitle(item).length, 160)
  assert.ok(item.kind === 'history')
  assert.equal(item.snapshot.sessionPath, undefined)
  assert.ok(item.snapshot.fields.every((field) => field.value.length <= 256))
  assert.ok(storage.value!.length <= 128 * 1024)
})

test('retained rows and details never offer stale retry or stop operations, but preserve safe navigation', () => {
  const history = new BackgroundJobHistory()
  history.observe(terminalJobs())
  const restored = history.select(empty()).recent
  for (const item of restored) {
    assert.equal(canStopJob(item), false)
    const common = {
      item,
      nowMs: Date.parse(end),
      busy: false,
      onStop: () => undefined,
      onRetry: () => undefined
    }
    const row = render(createElement(BackgroundJobRow, { ...common, onOpen: () => undefined }))
    const detail = render(
      createElement(BackgroundJobDetail, {
        ...common,
        onBack: () => undefined,
        onOpenSession: () => undefined,
        onOpenWrapper: () => undefined
      })
    )
    assert.doesNotMatch(row + detail, />重试<|aria-label="停止|取消构建|取消添加|取消上传/)
    assert.doesNotMatch(detail, /PRIVATE_/)
    if (item.kind === 'history' && item.snapshot.sessionPath) assert.match(detail, /打开对话/)
    if (item.kind === 'history' && item.snapshot.wrapperId) assert.match(detail, /打开 Wrapper/)
  }
})

test('display metadata redacts credential-like title and path fragments before persistence', () => {
  const storage = new MemoryStorage()
  const history = new BackgroundJobHistory(storage)
  const live = selectBackgroundJobs(
    [
      agent({
        agentName: 'api_key=private-title-token',
        sessionTitle: 'Authorization: Bearer private-bearer-value'
      })
    ],
    []
  )
  history.observe(live.recent)
  assert.doesNotMatch(storage.value!, /private-title-token|private-bearer-value/)
  assert.match(storage.value!, /已隐藏/)
})
