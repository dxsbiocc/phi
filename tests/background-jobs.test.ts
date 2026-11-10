import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import {
  AnimatedList,
  AnimatedListItem
} from '../src/renderer/src/features/jobs/components/AnimatedList'

import type { BackgroundAgentJob, BackgroundShellJob } from '../src/shared/backgroundJobTypes'
import type { EnvironmentBuild } from '../src/shared/environmentBuildTypes'
import type { RemoteProjectUploadJob } from '../src/shared/remoteProjectUploadTypes'
import type { WrapperRun } from '../src/shared/wrapperTypes'
import { BackgroundJobsPanel } from '../src/renderer/src/features/jobs/BackgroundJobsPanel'
import { BackgroundJobDetail } from '../src/renderer/src/features/jobs/components/BackgroundJobDetail'
import { scrollJupyterLogToEnd } from '../src/renderer/src/features/jobs/lib/jupyterLogScroll'
import { BackgroundJobGroup } from '../src/renderer/src/components/BackgroundJobGroup'
import { BackgroundJobRow } from '../src/renderer/src/features/jobs/components/BackgroundJobRow'
import { BackgroundWorkflowRow } from '../src/renderer/src/features/jobs/components/BackgroundWorkflowRow'
import { BackgroundJobIcon } from '../src/renderer/src/features/jobs/components/BackgroundJobIcon'
import { BackgroundJobArrivalNotice } from '../src/renderer/src/features/jobs/components/BackgroundJobArrivalNotice'
import { newlyObservedJobs } from '../src/renderer/src/features/jobs/hooks/useBackgroundJobArrivals'
import { groupBackgroundJobs } from '../src/renderer/src/features/jobs/lib/backgroundJobGroups'
import {
  remoteJupyterEntryLabel,
  remoteJupyterPhaseLabel
} from '../src/renderer/src/features/jobs/lib/backgroundJobLabels'
import type { RemoteJupyterStartJob } from '../src/shared/remoteJupyterJobTypes'
import {
  canStopUnifiedWrapperRun,
  dismissBackgroundJobs,
  dismissedBackgroundJobKeys,
  resetBackgroundJobTray,
  environmentBuildDetail,
  environmentBuildPercent,
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

// Keep the existing Chinese behavior assertions explicit; English switching has dedicated coverage.
setUiLanguage('zh-CN')

test('arrival detection reports a task only once across status refreshes', () => {
  const first = selectBackgroundJobs([agent], []).active
  const known = new Set(first.map((item) => item.key))
  assert.deepEqual(newlyObservedJobs(first, known), [])

  const next = selectBackgroundJobs(
    [agent, { ...agent, agentRunId: 'agent-2', agentName: 'Researcher' }],
    []
  ).active
  assert.deepEqual(
    newlyObservedJobs(next, known).map((item) => item.key),
    ['agent:runtime-1:agent-2']
  )
  assert.deepEqual(newlyObservedJobs(next, known), [])
})

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
    { maxRecent: 1 }
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

test('job overview keeps a live background shell command with its conversation', () => {
  const shell: BackgroundShellJob = {
    agentSessionId: 'runtime-1',
    jobId: 'bg_1',
    sessionId: 'session-1',
    sessionPath: 'phi-session:session-1',
    sessionTitle: 'Analyze samples',
    command: 'sleep 30',
    state: 'running',
    startedAt: '2026-09-27T10:02:00.000Z'
  }
  const live = selectBackgroundJobs([], [], {}, [shell])
  assert.deepEqual(
    live.active.map((item) => item.key),
    ['shell:runtime-1:bg_1']
  )
  assert.equal(
    live.active[0]?.kind === 'shell' && live.active[0].run.sessionPath,
    'phi-session:session-1'
  )

  const finished = selectBackgroundJobs([], [], { finishedAfter: '2026-09-30T02:00:00.000Z' }, [
    {
      ...shell,
      state: 'completed',
      completedAt: '2026-09-27T10:02:00.000Z'
    }
  ])
  assert.deepEqual(finished.recent, [])
})

test('job tray keeps live runs and only finished runs from this session', () => {
  resetBackgroundJobTray('2026-09-30T02:00:00.000Z')
  try {
    const result = selectBackgroundJobs(
      [
        {
          ...agent,
          agentRunId: 'agent-old',
          state: 'done',
          completedAt: '2026-09-27T10:05:00.000Z'
        },
        {
          ...agent,
          agentRunId: 'agent-new',
          state: 'done',
          completedAt: '2026-09-30T02:05:00.000Z'
        }
      ],
      [
        wrapper({ runId: 'wrun_live', createdAt: '2026-09-29T01:00:00.000Z' }),
        wrapper({
          runId: 'wrun_old',
          state: 'completed',
          completedAt: '2026-09-27T10:06:00.000Z',
          updatedAt: '2026-09-30T03:00:00.000Z'
        }),
        wrapper({
          runId: 'wrun_new',
          state: 'completed',
          completedAt: '2026-09-30T02:06:00.000Z'
        })
      ],
      { finishedAfter: '2026-09-30T02:00:00.000Z' }
    )
    assert.deepEqual(
      result.active.map((item) => item.key),
      ['wrapper:wrun_live']
    )
    assert.deepEqual(
      result.recent.map((item) => item.key),
      ['wrapper:wrun_new', 'agent:runtime-1:agent-new']
    )

    dismissBackgroundJobs(['wrapper:wrun_new'])
    const afterDismiss = selectBackgroundJobs(
      [],
      [
        wrapper({
          runId: 'wrun_new',
          state: 'completed',
          completedAt: '2026-09-30T02:06:00.000Z'
        })
      ],
      {
        finishedAfter: '2026-09-30T02:00:00.000Z',
        dismissedKeys: dismissedBackgroundJobKeys()
      }
    )
    assert.deepEqual(afterDismiss.recent, [])
  } finally {
    resetBackgroundJobTray()
  }
})

test('job overview uses the existing cancellation policy for Wrapper runs', () => {
  assert.equal(canStopUnifiedWrapperRun(wrapper({ origin: 'composition' })), true)
  assert.equal(canStopUnifiedWrapperRun(wrapper({ state: 'queued' })), true)
  assert.equal(canStopUnifiedWrapperRun(wrapper({ executor: 'slurm-controller' })), true)
  assert.equal(canStopUnifiedWrapperRun(wrapper({ state: 'running', executor: 'local' })), false)
  assert.equal(canStopUnifiedWrapperRun(wrapper({ state: 'completed' })), false)
})

test('remote project uploads appear with transfer progress and remain retryable after failure', () => {
  const upload: RemoteProjectUploadJob = {
    id: 'upload-1',
    status: 'uploading',
    sourcePaths: ['/tmp/sample.fastq.gz'],
    destinationDirectory: 'reads',
    totalFiles: 1,
    totalBytes: 1024,
    bytesTransferred: 512,
    bytesPerSecond: 256,
    requiresConfirmation: false,
    confirmed: true,
    files: [
      {
        localPath: '/tmp/sample.fastq.gz',
        relativePath: 'sample.fastq.gz',
        name: 'sample.fastq.gz',
        size: 1024,
        sha256: 'a'.repeat(64),
        resolution: 'pending'
      }
    ],
    createdAt: Date.parse('2026-10-12T00:00:00.000Z'),
    updatedAt: Date.parse('2026-10-12T00:00:01.000Z')
  }
  const active = selectBackgroundJobs([], [], {}, [], [], [], [upload])
  assert.deepEqual(
    active.active.map((item) => item.key),
    ['upload:upload-1']
  )
  assert.equal(active.active[0]?.kind, 'upload')

  const failed = selectBackgroundJobs(
    [],
    [],
    {},
    [],
    [],
    [],
    [{ ...upload, status: 'failed', error: 'connection lost' }]
  )
  assert.deepEqual(failed.active, [])
  assert.equal(failed.recent[0]?.key, 'upload:upload-1')
})

test('right sidebar job panel is available even when no job is running', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(BackgroundJobsPanel, {
        onOpenSession: () => undefined
      })
    )
  )
  assert.match(markup, /data-phi-background-jobs-panel="true"/)
  assert.doesNotMatch(markup, /后台任务 · 0 个进行中|aria-label="刷新后台任务"/)
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
    { maxRecent: 2 },
    [],
    [
      environment({ envId: 'env-live', startedAt: '2026-09-27T10:03:00.000Z' }),
      environment({
        envId: 'env-done',
        state: 'ready',
        startedAt: '2026-09-27T09:00:00.000Z',
        finishedAt: '2026-09-27T10:04:00.000Z'
      })
    ]
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
    {},
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

const jupyterJob: RemoteJupyterStartJob = {
  id: 'jup-1',
  projectId: 'project-1',
  projectName: 'GPU',
  serverLabel: 'gpu-login',
  state: 'failed',
  phase: 'Startup failed',
  phaseCode: 'failed',
  startedAt: '2026-09-27T10:00:00.000Z',
  finishedAt: '2026-09-27T10:01:00.000Z',
  error: 'Remote Jupyter was not ready after 3 attempts: the process exited early',
  entries: [
    {
      at: '2026-09-27T10:00:01.000Z',
      kind: 'step',
      text: 'Connecting to gpu-login to prepare remote Jupyter',
      code: 'connecting',
      params: { serverLabel: 'gpu-login' }
    },
    {
      at: '2026-09-27T10:00:30.000Z',
      kind: 'output',
      text: 'ModuleNotFoundError: No module named jupyter_server'
    },
    { at: '2026-09-27T10:01:00.000Z', kind: 'error', text: 'The process exited early' }
  ]
}

test('remote Jupyter phase and step codes switch languages and preserve fallback text', () => {
  const adapterProgressCases = [
    [
      'checking_configured_jupyter',
      { configuredPath: '/opt/jupyter/bin/jupyter' },
      "Checking Jupyter path /opt/jupyter/bin/jupyter and the server login shell's PATH…",
      '正在检查 Jupyter 路径 /opt/jupyter/bin/jupyter，以及服务器登录 shell 的 PATH…'
    ],
    [
      'checking_server_path_jupyter',
      undefined,
      "Checking the server login shell's PATH for an existing Jupyter…",
      '正在检测服务器登录 shell 的 PATH 中已有的 Jupyter…'
    ],
    [
      'missing_jupyter_using_managed',
      { environmentRef: 'phi:jupyter@1' },
      'No usable Jupyter Server was found on the server (jupyter server and ipykernel are required). Using Phi managed environment phi:jupyter@1; first-time setup may take a few minutes.',
      '服务器上没有可用的 Jupyter Server（需要 jupyter server 与 ipykernel）；改用 Phi 受管环境 phi:jupyter@1，首次创建可能需要几分钟。'
    ],
    [
      'using_existing_jupyter',
      {
        jupyterPath: '/opt/jupyter/bin/jupyter',
        version: '2.14.2',
        pythonPath: '/opt/jupyter/bin/python'
      },
      'Using existing server Jupyter: /opt/jupyter/bin/jupyter (jupyter_server 2.14.2); kernel Python: /opt/jupyter/bin/python',
      '使用服务器已有的 Jupyter：/opt/jupyter/bin/jupyter（jupyter_server 2.14.2），kernel Python：/opt/jupyter/bin/python'
    ],
    [
      'using_managed_jupyter',
      { jupyterPath: '/runtime/envs/jupyter/bin/jupyter' },
      'Using Jupyter from the managed environment: /runtime/envs/jupyter/bin/jupyter',
      '使用受管环境中的 Jupyter：/runtime/envs/jupyter/bin/jupyter'
    ]
  ] as const
  const phaseCases = [
    ['preparing', undefined, 'Preparing to start', '准备启动'],
    [
      'connecting',
      { serverLabel: 'gpu-login' },
      'Connecting to gpu-login to prepare remote Jupyter',
      '连接 gpu-login，准备启动远程 Jupyter'
    ],
    ...adapterProgressCases,
    ['allocating_ports', undefined, 'Allocating remote ports', '分配远端端口'],
    [
      'starting_lease',
      undefined,
      'Starting Jupyter Server over SSH',
      '通过 SSH 启动 Jupyter Server'
    ],
    [
      'probing_through_tunnel',
      undefined,
      'Waiting for Jupyter over the SSH tunnel',
      '经 SSH 隧道等待 Jupyter 就绪'
    ],
    ['ready', undefined, 'Jupyter Server is ready', 'Jupyter Server 已就绪'],
    [
      'cleaning',
      undefined,
      'Cleaning up remote processes from this startup',
      '清理本次启动留下的远端进程'
    ],
    [
      'reconciling',
      undefined,
      'Checking whether the previous Jupyter process has exited',
      '确认旧 Jupyter 是否已退出'
    ],
    ['disconnected', undefined, 'SSH connection disconnected', 'SSH 连接已断开'],
    ['failed', undefined, 'Startup failed', '启动失败'],
    ['cancelled', undefined, 'Stopped', '已停止']
  ] as const
  const entryCases = [
    [
      'connecting',
      { serverLabel: 'gpu-login' },
      'Connecting to gpu-login to prepare remote Jupyter',
      '连接 gpu-login，准备启动远程 Jupyter'
    ],
    ...adapterProgressCases,
    ['allocating_ports', undefined, 'Allocating remote ports', '分配远端端口'],
    [
      'starting_lease',
      undefined,
      'Starting Jupyter Server over SSH',
      '通过 SSH 启动 Jupyter Server'
    ],
    [
      'probing_through_tunnel',
      undefined,
      'Waiting for Jupyter over the SSH tunnel',
      '经 SSH 隧道等待 Jupyter 就绪'
    ],
    ['ready', undefined, 'Jupyter Server is ready', 'Jupyter Server 已就绪'],
    [
      'cleaning',
      undefined,
      'Cleaning up remote processes from this startup',
      '清理本次启动留下的远端进程'
    ],
    [
      'reconciling',
      undefined,
      'Checking whether the previous Jupyter process has exited',
      '确认旧 Jupyter 是否已退出'
    ],
    ['disconnected', undefined, 'SSH connection disconnected', 'SSH 连接已断开'],
    ['startup_cancelled', undefined, 'Startup stopped', '已停止启动']
  ] as const

  try {
    for (const language of ['en', 'zh-CN'] as const) {
      setUiLanguage(language)
      for (const [phaseCode, phaseParams, english, chinese] of phaseCases) {
        assert.equal(
          remoteJupyterPhaseLabel({ phase: 'PHASE_FALLBACK', phaseCode, phaseParams }),
          language === 'en' ? english : chinese
        )
      }
      for (const [code, params, english, chinese] of entryCases) {
        assert.equal(
          remoteJupyterEntryLabel({
            at: '2026-09-27T10:00:00.000Z',
            kind: 'step',
            text: 'ENTRY_FALLBACK',
            code,
            params
          }),
          language === 'en' ? english : chinese
        )
      }
    }

    assert.equal(
      remoteJupyterPhaseLabel({ phase: 'missing code fallback' }),
      'missing code fallback'
    )
    assert.equal(
      remoteJupyterPhaseLabel({ phase: 'unknown code fallback', phaseCode: 'future_code' }),
      'unknown code fallback'
    )
    assert.equal(
      remoteJupyterEntryLabel({
        at: '2026-09-27T10:00:00.000Z',
        kind: 'step',
        text: 'unknown entry fallback',
        code: 'future_code'
      }),
      'unknown entry fallback'
    )
    assert.equal(
      remoteJupyterEntryLabel({
        at: '2026-09-27T10:00:00.000Z',
        kind: 'step',
        text: 'fallback with detail',
        code: 'starting_lease',
        params: { detail: 'server detail' }
      }),
      '通过 SSH 启动 Jupyter Server: server detail'
    )
    assert.equal(
      remoteJupyterEntryLabel({
        at: '2026-09-27T10:00:00.000Z',
        kind: 'output',
        text: 'RAW_SERVER_OUTPUT',
        code: 'ready'
      }),
      'RAW_SERVER_OUTPUT'
    )
  } finally {
    setUiLanguage('zh-CN')
  }
})

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

test('remote Jupyter startups are jobs: running ones are active, finished ones are completed', () => {
  const running = { ...jupyterJob, state: 'running' as const, finishedAt: undefined }
  const result = selectBackgroundJobs(
    [],
    [],
    { finishedAfter: '2026-09-27T09:00:00.000Z' },
    [],
    [],
    [],
    [],
    [running, { ...jupyterJob, id: 'jup-0' }]
  )
  assert.deepEqual(
    result.active.map((item) => item.key),
    ['jupyter:jup-1']
  )
  assert.deepEqual(
    result.recent.map((item) => item.key),
    ['jupyter:jup-0']
  )
})

test('job groups collapse and expand with their count', () => {
  const props = {
    id: 'running',
    title: '运行中',
    count: 2,
    onToggle: () => undefined,
    children: 'rows'
  }
  const open = render(createElement(BackgroundJobGroup, { ...props, expanded: true }, 'rows'))
  const closed = render(createElement(BackgroundJobGroup, { ...props, expanded: false }, 'rows'))
  assert.match(open, /aria-expanded="true"/)
  assert.match(open, /运行中/)
  assert.match(open, />2</)
  assert.match(closed, /aria-expanded="false"/)
})

test('a job row opens its detail as a whole and no longer jumps to the conversation', () => {
  const [item] = selectBackgroundJobs([agent], []).active
  assert.ok(item)
  const markup = render(
    createElement(BackgroundJobRow, {
      item,
      nowMs: Date.parse('2026-09-27T10:00:05.000Z'),
      busy: false,
      onOpen: () => undefined,
      onStop: () => undefined
    })
  )
  assert.match(markup, /role="button"/)
  assert.match(markup, /data-phi-background-job-icon="agent"/)
  assert.match(markup, /aria-label="查看 Wrapper 详情"/)
  assert.doesNotMatch(markup, /打开对话/)
  assert.match(markup, /aria-label="停止 Wrapper"/)
  assert.match(markup, /height:68px/)
})

test('active and finished task cards retain the same fixed height', () => {
  const [active] = selectBackgroundJobs([agent], []).active
  const [finished] = selectBackgroundJobs(
    [{ ...agent, state: 'done', completedAt: '2026-09-27T10:01:00.000Z' }],
    []
  ).recent
  assert.ok(active && finished)
  for (const item of [active, finished]) {
    const markup = render(
      createElement(BackgroundJobRow, {
        item,
        nowMs: Date.parse('2026-09-27T10:02:00.000Z'),
        busy: false,
        onOpen: () => undefined,
        onStop: () => undefined
      })
    )
    assert.match(markup, /height:68px/)
  }
})

test('Jupyter job cards use the current Phi material icon', () => {
  const markup = render(createElement(BackgroundJobIcon, { kind: 'jupyter' }))
  assert.match(markup, /data-phi-material-icon="jupyter"/)
})

test('a grouped RNA-seq run uses one compact parent card with Slurm context', () => {
  const live = selectBackgroundJobs(
    [],
    [
      wrapper({
        origin: 'composition',
        executor: 'slurm',
        workflow: { id: 'rna-1', name: 'RNA-seq', step: 'QC', totalSteps: 4 }
      })
    ]
  )
  const workflow = groupBackgroundJobs(live.active)[0]
  assert.equal(workflow.kind, 'workflow')
  if (workflow.kind !== 'workflow') return
  const markup = render(
    createElement(BackgroundWorkflowRow, {
      workflow,
      expanded: false,
      onToggle: () => undefined,
      renderChild: () => null
    })
  )
  assert.match(markup, /data-phi-background-workflow="workflow:rna-1"/)
  assert.match(markup, /RNA-seq/)
  assert.match(markup, /0\/4 步完成/)
  assert.match(markup, /Slurm/)
  assert.match(markup, /min-height:68px/)
})

test('an expanded workflow step shows its name and status without a label above the card', () => {
  const live = selectBackgroundJobs(
    [],
    [
      wrapper({
        runId: 'wrun_fastqc',
        executor: 'slurm',
        remote: { host: 'GPU', runDir: '/remote/run' },
        wrapper: {
          canonicalId: 'nf-core/modules/fastqc',
          namespace: 'nf-core/modules',
          shortId: 'fastqc',
          version: '1.0.0'
        },
        workflow: { id: 'rna-1', name: 'Paired-end RNA-seq', step: '1_fastqc', totalSteps: 4 }
      })
    ]
  )
  const workflow = groupBackgroundJobs(live.active)[0]
  assert.equal(workflow.kind, 'workflow')
  if (workflow.kind !== 'workflow') return
  const markup = render(
    createElement(BackgroundWorkflowRow, {
      workflow,
      expanded: true,
      onToggle: () => undefined,
      renderChild: (job) =>
        createElement(BackgroundJobRow, {
          compact: true,
          item: job,
          nowMs: Date.parse('2026-09-27T10:02:00.000Z'),
          busy: false,
          onOpen: () => undefined,
          onStop: () => undefined
        })
    })
  )
  assert.match(markup, /1_fastqc/)
  assert.doesNotMatch(markup, /fastqc ·/)
  assert.doesNotMatch(markup, /Wrapper · wrun_fastqc/)
  assert.match(markup, /height:44px/)
})

test('animated list starts new cards at the reference zero scale', () => {
  const markup = render(
    createElement(
      AnimatedList,
      { animateInitial: true } as ComponentProps<typeof AnimatedList>,
      createElement(
        AnimatedListItem,
        { enterDelayMs: 65 } as ComponentProps<typeof AnimatedListItem>,
        'Task'
      )
    )
  )
  assert.match(markup, /opacity:0;transform:scale\(0\)/)
})

test('arrival animation host stays mounted before the first new task', () => {
  const markup = render(
    createElement(BackgroundJobArrivalNotice, {
      onOpen: () => undefined
    })
  )
  assert.match(markup, /data-phi-background-job-arrivals="floating"/)
})

test('starting remote Jupyter does not open the jobs panel automatically', () => {
  const appSource = readFileSync(resolve('src/renderer/src/App.tsx'), 'utf8')
  const startRuntime = appSource
    .split('onStartRuntime: (cwd) => {')[1]
    ?.split('onOpenRuntimeStartLog:')[0]
  assert.ok(startRuntime)
  assert.doesNotMatch(startRuntime, /onOpenJupyterStartLog|onOpenBackgroundJobs/)
})

test('a failed Jupyter startup shows its error and full startup log inside the panel', () => {
  const [item] = selectBackgroundJobs([], [], {}, [], [], [], [], [jupyterJob]).recent
  assert.ok(item)
  const markup = render(
    createElement(BackgroundJobDetail, {
      item,
      nowMs: Date.parse('2026-09-27T10:02:00.000Z'),
      busy: false,
      onBack: () => undefined,
      onStop: () => undefined,
      onOpenSession: () => undefined
    })
  )
  assert.match(markup, /aria-label="返回任务列表"/)
  assert.match(markup, /aria-label="复制详情"/)
  assert.match(markup, /padding-left:0/)
  assert.match(markup, /启动 Jupyter Server · GPU/)
  assert.match(markup, /启动失败/)
  assert.match(markup, /Remote Jupyter was not ready after 3 attempts: the process exited early/)
  assert.match(markup, /data-phi-jupyter-start-log/)
  assert.match(markup, /max-height:480px/)
  assert.match(markup, /No module named jupyter_server/)
  assert.match(markup, /gpu-login/)
})

test('Jupyter log following scrolls its viewport without invoking ancestor scrolling', () => {
  const viewport = {
    scrollTop: 0,
    scrollHeight: 840,
    scrollIntoView: (): never => {
      throw new Error('scrollIntoView would move the outer pane')
    }
  }
  scrollJupyterLogToEnd(viewport)
  assert.equal(viewport.scrollTop, 840)
})

test('agent job details keep an explicit button to open the conversation', () => {
  const [item] = selectBackgroundJobs([agent], []).active
  assert.ok(item)
  const markup = render(
    createElement(BackgroundJobDetail, {
      item,
      nowMs: Date.parse('2026-09-27T10:00:05.000Z'),
      busy: false,
      onBack: () => undefined,
      onStop: () => undefined,
      onOpenSession: () => undefined
    })
  )
  assert.match(markup, /Run quality control/)
  assert.match(markup, /打开对话/)
  assert.match(markup, /停止这个 Agent/)
})
