import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import RuntimeView, {
  type RuntimeViewProps
} from '../src/renderer/src/features/runtime/RuntimeView'
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
    activeSessionCount: 2,
    busySessionCount: 1,
    sessions: [
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
      }
    ]
  }
}

function renderRuntimeView(
  status: AnalysisJupyterRuntimeStatus | null = runtimeStatus,
  overrides: Partial<RuntimeViewProps> = {}
): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(RuntimeView, {
        projectCwd: '/projects/research',
        projectName: 'Research',
        runtimeStatus: status,
        onRefresh: () => undefined,
        onStartJupyter: () => undefined,
        onStopJupyter: () => undefined,
        onOpenNotebook: () => undefined,
        onStopNotebookKernel: () => undefined,
        ...overrides
      })
    )
  )
}

test('runtime view shows real Jupyter server and notebook session summary', () => {
  const markup = renderRuntimeView()

  assert.match(markup, /Jupyter Runtime/)
  assert.match(markup, /Research/)
  assert.match(markup, /Jupyter Server/)
  assert.match(markup, /Ready/)
  assert.match(markup, /PID 2026/)
  assert.match(markup, /Port 31888/)
  assert.match(markup, /2 active/)
  assert.match(markup, /1 running/)
  assert.match(markup, /eda\.ipynb/)
  assert.match(markup, /data-phi-runtime-notebook-open="true"/)
  assert.match(markup, /data-phi-runtime-notebook-open-target="filename"/)
  assert.match(markup, /aria-label="打开 eda\.ipynb"/)
  assert.match(markup, /Python 3/)
  assert.match(markup, /Server 正在为当前项目运行/)
  assert.match(markup, /关闭 eda\.ipynb kernel/)
  assert.match(markup, /data-phi-runtime-notebook-close-kernel="true"/)
  assert.match(markup, /data-phi-runtime-notebook-close-state="ready"/)
  assert.doesNotMatch(markup, /IPKernelApp/)
})

test('runtime view keeps kernel close enabled while refreshing runtime status', () => {
  const markup = renderRuntimeView(runtimeStatus, { isLoading: true })
  const labelIndex = markup.indexOf('aria-label="关闭 eda.ipynb kernel"')
  assert.notEqual(labelIndex, -1)
  const closeButtonStart = markup.lastIndexOf('<button', labelIndex)
  const closeButtonEnd = markup.indexOf('</button>', labelIndex)
  const closeButtonMarkup = markup.slice(closeButtonStart, closeButtonEnd)

  assert.match(closeButtonMarkup, /data-phi-runtime-notebook-close-state="ready"/)
  assert.doesNotMatch(closeButtonMarkup, /disabled/)
})

test('runtime view disables only the kernel currently being closed', () => {
  const markup = renderRuntimeView(runtimeStatus, {
    closingNotebookPath: '/projects/research/notebooks/eda.ipynb'
  })

  assert.match(markup, /data-phi-runtime-notebook-close-state="closing"/)
  assert.match(markup, /disabled/)
})

test('runtime view leaves notebook sessions non-clickable without an open handler', () => {
  const markup = renderRuntimeView(runtimeStatus, { onOpenNotebook: undefined })

  assert.match(markup, /eda\.ipynb/)
  assert.doesNotMatch(markup, /data-phi-runtime-notebook-open="true"/)
  assert.doesNotMatch(markup, /aria-label="打开 eda\.ipynb"/)
})

test('runtime view renders an empty kernel state without placeholder features', () => {
  const markup = renderRuntimeView({
    ...runtimeStatus,
    notebooks: { activeSessionCount: 0, busySessionCount: 0, sessions: [] }
  })

  assert.match(markup, /当前项目还没有连接中的 notebook kernel/)
  assert.doesNotMatch(markup, /Nextflow/)
  assert.doesNotMatch(markup, /Slurm/)
})

test('runtime view keeps the no-project state quiet and left aligned', () => {
  const theme = createTheme()
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(RuntimeView, {
        projectCwd: '',
        runtimeStatus: null,
        error: '请选择一个已添加的项目',
        onRefresh: () => undefined,
        onStartJupyter: () => undefined,
        onStopJupyter: () => undefined,
        onStopNotebookKernel: () => undefined
      })
    )
  )

  assert.match(markup, /未选择项目/)
  assert.match(markup, /先从左侧项目列表打开一个项目会话/)
  assert.doesNotMatch(markup, /请选择一个已添加的项目/)
  assert.doesNotMatch(markup, /MuiAlert/)
})
