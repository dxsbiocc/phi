import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { RuntimeSidebar } from '../src/renderer/src/features/runtime/RuntimeView'
import type { AnalysisJupyterRuntimeStatus } from '../src/renderer/src/types'

const runtimeStatus: AnalysisJupyterRuntimeStatus = {
  server: {
    projectCwd: '/projects/research',
    state: 'ready',
    startedAt: '2026-09-10T01:00:00.000Z',
    pid: 2026,
    port: 31888,
    hasEndpoint: true,
    message:
      '[IPKernelApp] WARNING | Kernel is running over TCP without encryption. All communication is sent in plain text.'
  },
  notebooks: {
    activeSessionCount: 3,
    busySessionCount: 2,
    sessions: [
      {
        projectCwd: '/projects/research',
        notebookPath: '/projects/research/notebooks/r_analysis.ipynb',
        kernelName: 'ir',
        kernelDisplayName: 'R',
        sessionId: 'session-r',
        state: 'busy',
        message: 'Notebook kernel 正在执行',
        startedAt: '2026-09-10T01:00:00.000Z',
        updatedAt: '2026-09-10T01:03:00.000Z'
      },
      {
        projectCwd: '/projects/research',
        notebookPath: '/projects/research/notebooks/eda.ipynb',
        kernelName: 'python3',
        kernelDisplayName: 'Python 3',
        sessionId: 'session-1',
        state: 'busy',
        message: 'Notebook kernel 正在执行',
        startedAt: '2026-09-10T01:00:00.000Z',
        updatedAt: '2026-09-10T01:02:00.000Z'
      },
      {
        projectCwd: '/projects/research',
        notebookPath: '/projects/research/notebooks/idle.ipynb',
        kernelName: 'python3',
        kernelDisplayName: 'Python 3',
        sessionId: 'session-idle',
        state: 'idle',
        startedAt: '2026-09-10T01:00:00.000Z',
        updatedAt: '2026-09-10T01:01:00.000Z'
      }
    ]
  }
}

function renderRuntimeSidebar(
  status: AnalysisJupyterRuntimeStatus | null = runtimeStatus,
  overrides: Partial<ComponentProps<typeof RuntimeSidebar>> = {}
): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(RuntimeSidebar, {
        projectCwd: '/projects/research',
        runtimeStatus: status,
        onOpenNotebook: () => undefined,
        onStartJupyter: () => undefined,
        onStopJupyter: () => undefined,
        onStopNotebookKernel: () => undefined,
        onRefresh: () => undefined,
        ...overrides
      })
    )
  )
}

test('runtime sidebar shows global Jupyter Server before Notebook Kernels', () => {
  const markup = renderRuntimeSidebar()

  const serverIndex = markup.indexOf('Jupyter Server')
  const kernelsIndex = markup.indexOf('Notebook Kernels')
  assert.ok(serverIndex >= 0)
  assert.ok(kernelsIndex > serverIndex)
  assert.match(markup, /data-phi-runtime-sidebar-server="true"/)
  assert.match(markup, /data-phi-runtime-sidebar-kernel="true"/)
  assert.match(markup, /runtime-sidebar-row-actions/)
  assert.match(markup, /aria-label="刷新 Server 状态"/)
  assert.match(markup, /aria-label="停止 Jupyter server"/)
  assert.doesNotMatch(markup, /aria-label="启动 Jupyter server"/)
  assert.match(markup, /aria-label="关闭 eda\.ipynb kernel"/)
  assert.match(markup, /data-phi-runtime-sidebar-kernel-close="true"/)
  assert.match(markup, /data-phi-runtime-sidebar-kernel-close-state="ready"/)
  assert.match(markup, /data-phi-runtime-sidebar-running-kernel-count="true"/)
  assert.doesNotMatch(markup, /2 busy/)
  assert.match(markup, /data-phi-runtime-sidebar-kernel-icon="r"/)
  assert.match(markup, /data-phi-runtime-sidebar-kernel-icon="python"/)
  assert.match(markup, /PID 2026/)
  assert.match(markup, /Port 31888/)
  assert.match(markup, /r_analysis\.ipynb/)
  assert.match(markup, />R</)
  assert.match(markup, /eda\.ipynb/)
  assert.match(markup, /Python 3/)
  assert.match(markup, /idle\.ipynb/)
  assert.doesNotMatch(markup, /正在执行/)
  assert.doesNotMatch(markup, /已连接/)
  assert.doesNotMatch(markup, /Ready · Research/)
  assert.doesNotMatch(markup, /Ready · test/)
  assert.doesNotMatch(markup, /aria-label="打开 eda\.ipynb"/)
  assert.doesNotMatch(markup, /data-phi-runtime-notebook-open/)
  assert.doesNotMatch(markup, /aria-label="刷新运行时"/)
  assert.doesNotMatch(markup, /Jupyter Runtime/)
  assert.doesNotMatch(markup, />运行时</)
})

test('remote runtime shows the login server and recovery guidance without local PID or port', () => {
  const markup = renderRuntimeSidebar({
    ...runtimeStatus,
    server: {
      projectCwd: '/canonical/project',
      runtimeKind: 'ssh',
      serverLabel: 'cluster-login',
      state: 'disconnected',
      hasEndpoint: false,
      message: '连接已断开；重新连接后 kernel 将重启，内存状态会丢失。'
    }
  })

  assert.match(markup, /cluster-login/)
  assert.match(markup, /登录节点/)
  assert.match(markup, /连接已断开/)
  assert.match(markup, /kernel 将重启/)
  assert.doesNotMatch(markup, /PID 2026|Port 31888/)
  assert.match(markup, /aria-label="启动 Jupyter server"/)
})

test('remote environment preparation keeps the stop action available for cancellation', () => {
  const markup = renderRuntimeSidebar(
    {
      ...runtimeStatus,
      server: {
        projectCwd: '/canonical/project',
        runtimeKind: 'ssh',
        serverLabel: 'cluster-login',
        state: 'preparing_environment',
        hasEndpoint: false,
        message: '正在准备；可停止以取消。'
      }
    },
    { isLoading: true }
  )

  assert.match(markup, /aria-label="停止 Jupyter server"/)
  assert.doesNotMatch(markup, /aria-label="停止 Jupyter server"[^>]*disabled/)
})

test('runtime sidebar swaps server start and stop actions in one slot', () => {
  const stoppedMarkup = renderRuntimeSidebar({
    ...runtimeStatus,
    server: {
      projectCwd: runtimeStatus.server.projectCwd,
      state: 'stopped',
      hasEndpoint: false
    }
  })

  assert.match(stoppedMarkup, /aria-label="启动 Jupyter server"/)
  assert.doesNotMatch(stoppedMarkup, /aria-label="停止 Jupyter server"/)
})

test('runtime sidebar action styling uses GoSync and no hover button borders', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/runtime/RuntimeView.tsx'),
    'utf8'
  )

  assert.match(source, /import \{ GoSync \} from 'react-icons\/go'/)
  assert.match(source, /const RefreshIcon = GoSync/)
  assert.doesNotMatch(source, /borderColor/)
  assert.doesNotMatch(source, /border:\s*1/)
  assert.match(source, /alignSelf:\s*'center'/)
  assert.doesNotMatch(source, /aria-label="刷新运行时"/)
  assert.doesNotMatch(source, /正在执行/)
})

test('runtime sidebar disables only the kernel currently being closed', () => {
  const markup = renderRuntimeSidebar(runtimeStatus, {
    closingNotebookPath: '/projects/research/notebooks/eda.ipynb'
  })

  assert.match(markup, /data-phi-runtime-sidebar-kernel-close-state="closing"/)
  assert.match(markup, /disabled/)
})

test('runtime sidebar renders the empty notebook kernel state inline', () => {
  const markup = renderRuntimeSidebar({
    ...runtimeStatus,
    notebooks: { activeSessionCount: 0, busySessionCount: 0, sessions: [] }
  })

  assert.match(markup, /Jupyter Server/)
  assert.match(markup, /Notebook Kernels/)
  assert.match(markup, /data-phi-runtime-sidebar-empty-kernels="true"/)
  assert.match(markup, /当前项目还没有运行中的 notebook kernel/)
  assert.doesNotMatch(markup, /Nextflow/)
  assert.doesNotMatch(markup, /Slurm/)
})
