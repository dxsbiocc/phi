import { beforeEach, afterEach } from 'node:test'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

// Keep these legacy behavioral assertions explicit about their presentation language.
beforeEach(() => setUiLanguage('zh-CN'))
afterEach(() => setUiLanguage('en'))

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

test('runtime sidebar shows the Jupyter Accordion before Notebook Kernels', () => {
  const markup = renderRuntimeSidebar()

  const serverIndex = markup.indexOf('本地 · Jupyter')
  const kernelsIndex = markup.indexOf('Notebook 内核')
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
  assert.match(markup, /端口 31888/)
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

test('runtime sidebar keeps local and remote servers visible together', () => {
  const remote: AnalysisJupyterRuntimeStatus = {
    server: {
      projectCwd: '/remote/research',
      runtimeKind: 'ssh',
      serverLabel: 'gpu-login',
      state: 'ready',
      hasEndpoint: true
    },
    notebooks: { activeSessionCount: 0, busySessionCount: 0, sessions: [] }
  }
  const markup = renderRuntimeSidebar(runtimeStatus, { additionalRuntimeStatuses: [remote] })

  assert.equal((markup.match(/data-phi-runtime-sidebar-server="true"/g) ?? []).length, 2)
  assert.match(markup, /gpu-login/)
  assert.match(markup, /PID 2026/)
  assert.match(markup, /本地/)
  assert.match(markup, /data-phi-runtime-group-kind="ssh"/)
  assert.match(markup, /data-phi-runtime-sidebar-server-cwd="\/remote\/research"/)
})

test('stopped remote Jupyter remains visible beside a running local server', () => {
  const remote: AnalysisJupyterRuntimeStatus = {
    server: {
      projectCwd: '/remote/research',
      runtimeKind: 'ssh',
      serverLabel: 'GPU',
      state: 'stopped',
      hasEndpoint: false
    },
    notebooks: { activeSessionCount: 0, busySessionCount: 0, sessions: [] }
  }
  const markup = renderRuntimeSidebar(runtimeStatus, { additionalRuntimeStatuses: [remote] })
  const gpuSection = markup.split('data-phi-runtime-sidebar-server-cwd="/remote/research"')[1] ?? ''

  assert.equal((markup.match(/data-phi-runtime-sidebar-server="true"/g) ?? []).length, 2)
  assert.match(markup, /GPU · Jupyter/)
  assert.match(gpuSection, /aria-label="启动 Jupyter server"/)
})

test('runtime sidebar groups local Jupyter and remote projects by server', () => {
  const remote = (cwd: string, host: string): AnalysisJupyterRuntimeStatus => ({
    server: {
      projectCwd: cwd,
      runtimeKind: 'ssh',
      serverLabel: host,
      state: 'ready',
      hasEndpoint: true
    },
    notebooks: { activeSessionCount: 0, busySessionCount: 0, sessions: [] }
  })
  const markup = renderRuntimeSidebar(runtimeStatus, {
    additionalRuntimeStatuses: [
      remote('/remote/first', 'GPU'),
      remote('/remote/second', 'GPU'),
      remote('/remote/third', 'CPU')
    ]
  })

  assert.equal((markup.match(/data-phi-runtime-group-kind="local"/g) ?? []).length, 1)
  assert.equal((markup.match(/data-phi-runtime-group-label="GPU"/g) ?? []).length, 1)
  assert.equal((markup.match(/data-phi-runtime-group-label="CPU"/g) ?? []).length, 1)
  assert.ok(
    markup.indexOf('data-phi-runtime-group-kind="local"') <
      markup.indexOf('data-phi-runtime-group-label="GPU"')
  )
  assert.ok(markup.indexOf('Notebook 内核') < markup.indexOf('data-phi-runtime-group-label="CPU"'))
  const gpuGroup =
    markup
      .split('data-phi-runtime-group-label="GPU"')[1]
      ?.split('data-phi-runtime-group-label="CPU"')[0] ?? ''
  assert.match(gpuGroup, /data-phi-runtime-sidebar-server-cwd="\/remote\/first"/)
  assert.match(gpuGroup, /data-phi-runtime-sidebar-server-cwd="\/remote\/second"/)
})

test('each Jupyter service expands its notebooks from an Accordion header', () => {
  const remote: AnalysisJupyterRuntimeStatus = {
    server: {
      projectCwd: '/remote/project',
      runtimeKind: 'ssh',
      serverLabel: 'GPU',
      state: 'ready',
      hasEndpoint: true
    },
    notebooks: { activeSessionCount: 0, busySessionCount: 0, sessions: [] }
  }
  const markup = renderRuntimeSidebar(runtimeStatus, {
    additionalRuntimeStatuses: [remote],
    onOpenStartLog: () => undefined
  })

  assert.equal((markup.match(/data-phi-runtime-accordion="true"/g) ?? []).length, 2)
  assert.match(markup, /本地 · Jupyter/)
  assert.match(markup, /GPU · Jupyter/)
  assert.equal((markup.match(/aria-expanded="true"/g) ?? []).length, 2)
  assert.ok(markup.indexOf('GPU · Jupyter') < markup.indexOf('data-phi-runtime-start-log'))
})

test('Jupyter Accordion keeps a borderless fixed header in both expansion states', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/runtime/RuntimeView.tsx'),
    'utf8'
  )
  assert.match(source, /border: '0 !important'/)
  assert.match(source, /m: '0 !important'/)
  assert.match(source, /'&\.Mui-expanded': \{ m: '0 !important' \}/)
  assert.match(source, /height: 64/)
  assert.match(source, /'&\.Mui-expanded': \{ minHeight: 64 \}/)
  assert.match(source, /scrollbarGutter: 'stable'/)
})

test('the local runtime group follows the selected interface language', () => {
  setUiLanguage('en')
  const markup = renderRuntimeSidebar()
  assert.match(markup, /data-phi-runtime-group-label="Local"/)
})

test('the active remote notebook kernel stays inside its server group', () => {
  const remote: AnalysisJupyterRuntimeStatus = {
    server: {
      projectCwd: '/remote/project',
      runtimeKind: 'ssh',
      serverLabel: 'GPU',
      state: 'ready',
      hasEndpoint: true
    },
    notebooks: {
      activeSessionCount: 1,
      busySessionCount: 0,
      sessions: [
        {
          projectCwd: '/remote/project',
          notebookPath: '/remote/project/notebooks/remote.ipynb',
          state: 'idle'
        }
      ]
    }
  }
  const markup = renderRuntimeSidebar(remote, {
    projectCwd: '/local/remote-anchor',
    currentRuntimeKind: 'ssh',
    currentServerLabel: 'GPU',
    additionalRuntimeStatuses: [runtimeStatus, remote]
  })

  assert.equal((markup.match(/data-phi-runtime-group-label="GPU"/g) ?? []).length, 1)
  assert.equal((markup.match(/data-phi-runtime-sidebar-server="true"/g) ?? []).length, 2)
  assert.ok(
    markup.indexOf('data-phi-runtime-group-kind="local"') <
      markup.indexOf('data-phi-runtime-group-label="GPU"')
  )
  const gpuGroup = markup.split('data-phi-runtime-group-label="GPU"')[1] ?? ''
  assert.match(gpuGroup, /Notebook 内核/)
  assert.match(gpuGroup, /remote\.ipynb/)
})

test('local and remote notebook kernels stay visible when switching the active notebook', () => {
  const remote: AnalysisJupyterRuntimeStatus = {
    server: {
      projectCwd: '/remote/project',
      runtimeKind: 'ssh',
      serverLabel: 'GPU',
      state: 'ready',
      hasEndpoint: true
    },
    notebooks: {
      activeSessionCount: 1,
      busySessionCount: 0,
      sessions: [
        {
          projectCwd: '/remote/project',
          notebookPath: '/remote/project/notebooks/quicksort.ipynb',
          kernelName: 'python3',
          state: 'idle'
        }
      ]
    }
  }
  const localActive = renderRuntimeSidebar(runtimeStatus, {
    additionalRuntimeStatuses: [remote]
  })
  const remoteActive = renderRuntimeSidebar(remote, {
    projectCwd: '/remote/project-anchor',
    currentRuntimeKind: 'ssh',
    currentServerLabel: 'GPU',
    additionalRuntimeStatuses: [runtimeStatus]
  })

  for (const markup of [localActive, remoteActive]) {
    assert.equal((markup.match(/data-phi-runtime-sidebar-kernel="true"/g) ?? []).length, 4)
    assert.match(markup, /r_analysis\.ipynb/)
    assert.match(markup, /quicksort\.ipynb/)
    assert.ok(
      markup.indexOf('data-phi-runtime-group-label="GPU"') < markup.indexOf('quicksort.ipynb')
    )
    assert.match(markup, /切换到此项目后打开/)
  }
  assert.equal((localActive.match(/data-phi-runtime-sidebar-kernel-close="true"/g) ?? []).length, 3)
  assert.equal(
    (remoteActive.match(/data-phi-runtime-sidebar-kernel-close="true"/g) ?? []).length,
    1
  )
})

test('a remote project loading its status reuses the matching server already in the inventory', () => {
  const remote: AnalysisJupyterRuntimeStatus = {
    server: {
      projectCwd: '/remote/project',
      runtimeKind: 'ssh',
      serverLabel: 'GPU',
      state: 'ready',
      hasEndpoint: true
    },
    notebooks: { activeSessionCount: 0, busySessionCount: 0, sessions: [] }
  }
  const markup = renderRuntimeSidebar(null, {
    projectCwd: '/local/remote-anchor',
    currentRuntimeKind: 'ssh',
    currentServerLabel: 'GPU',
    currentCanonicalCwd: '/remote/project',
    additionalRuntimeStatuses: [remote]
  })

  assert.equal((markup.match(/data-phi-runtime-sidebar-server="true"/g) ?? []).length, 1)
  assert.equal((markup.match(/data-phi-runtime-group-label="GPU"/g) ?? []).length, 1)
  assert.doesNotMatch(markup, /无服务地址/)
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

test('unconfirmed remote cleanup offers both retry and explicit local abandon actions', () => {
  const markup = renderRuntimeSidebar({
    ...runtimeStatus,
    server: {
      projectCwd: '/canonical/project',
      runtimeKind: 'ssh',
      serverLabel: 'cluster-login',
      state: 'error',
      hasEndpoint: false,
      cleanupUnconfirmed: true,
      canAbandonCleanup: true,
      message: '服务器暂时连不上，无法确认旧 Jupyter 已退出；网络恢复后再试。'
    }
  })

  assert.match(markup, /网络恢复后再试/)
  assert.match(markup, /aria-label="启动 Jupyter server"/)
  assert.match(markup, /aria-label="放弃未确认的远程 Jupyter 本地状态"/)
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
  assert.match(source, /visibility:\s*'visible'/)
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

  assert.match(markup, /本地 · Jupyter/)
  assert.match(markup, /Notebook 内核/)
  assert.match(markup, /data-phi-runtime-sidebar-empty-kernels="true"/)
  assert.match(markup, /当前项目还没有运行中的 notebook kernel/)
  assert.doesNotMatch(markup, /Nextflow/)
  assert.doesNotMatch(markup, /Slurm/)
})

test('a remote Jupyter card links to its startup log and keeps the full message reachable', () => {
  const message = '远程 Jupyter 在 3 次尝试后仍未就绪：远程 Jupyter 进程提前退出，详见日志'
  const props = {
    projectCwd: '/srv/project',
    runtimeStatus: {
      server: {
        projectCwd: '/srv/project',
        runtimeKind: 'ssh',
        serverLabel: 'GPU',
        state: 'error',
        hasEndpoint: false,
        message
      },
      notebooks: { activeSessionCount: 0, busySessionCount: 0, sessions: [] }
    } as unknown as AnalysisJupyterRuntimeStatus,
    onRefresh: () => undefined,
    onStartJupyter: () => undefined,
    onStopJupyter: () => undefined,
    onStopNotebookKernel: () => undefined
  }
  const render = (extra: Partial<ComponentProps<typeof RuntimeSidebar>>): string =>
    renderToStaticMarkup(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(RuntimeSidebar, { ...props, ...extra })
      )
    )
  const markup = render({ onOpenStartLog: () => undefined })
  assert.match(markup, /data-phi-runtime-start-log/)
  assert.match(markup, /查看启动日志/)
  assert.match(markup, /data-phi-runtime-group-label="GPU"/)
  assert.match(markup, new RegExp(`title="登录节点 · ${message}"`))
  assert.doesNotMatch(render({}), /查看启动日志/)
})
