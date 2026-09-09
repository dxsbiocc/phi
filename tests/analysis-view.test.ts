import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import AnalysisView, { type AnalysisViewProps } from '../src/renderer/src/components/AnalysisView'
import { parseNotebook } from '../src/shared/notebookDocument'

function renderAnalysisView(props: AnalysisViewProps = {}): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(ThemeProvider, { theme }, createElement(AnalysisView, props))
  )
}

test('analysis view renders the first-phase notebook shell', () => {
  const markup = renderAnalysisView()

  assert.match(markup, /分析/)
  assert.match(markup, /No notebook selected/)
  assert.match(markup, /Files/)
  assert.match(markup, /Variables/)
  assert.match(markup, /Artifacts/)
  assert.match(markup, /连接项目后显示真实 notebook 文件/)
  assert.match(markup, /当前容器未传入真实聊天面板/)
  assert.match(markup, /调整分析侧栏宽度/)
  assert.match(markup, /调整检查器宽度/)
  assert.match(markup, /关闭右侧栏/)
  assert.match(markup, /添加 Code cell/)
  assert.match(markup, /添加 Markdown cell/)
  assert.doesNotMatch(markup, /notebooks\/exploration\.ipynb/)
  assert.doesNotMatch(markup, /Python 3\.11 demo/)
  assert.doesNotMatch(markup, /Saving interactive artifact/)
  assert.doesNotMatch(markup, /Data Preview/)
  assert.doesNotMatch(markup, /Agent transaction/)
  assert.doesNotMatch(markup, /workflows\/main\.nf/)
  assert.doesNotMatch(markup, /运行全部 cell/)
  assert.doesNotMatch(markup, /更多 notebook 操作/)
  assert.doesNotMatch(markup, /更多 cell 操作/)
  assert.doesNotMatch(markup, /展开分析侧栏/)
})

test('analysis view can hide the right inspector behind the notebook toggle', () => {
  const markup = renderAnalysisView({ initialInspectorCollapsed: true })

  assert.match(markup, /展开右侧栏/)
  assert.doesNotMatch(markup, /调整检查器宽度/)
  assert.doesNotMatch(markup, /Inspector/)
  assert.doesNotMatch(markup, /workflows\/main\.nf/)
})

test('analysis view renders project notebook registry entries', () => {
  const markup = renderAnalysisView({
    initialLeftPanel: 'notebooks',
    notebookRegistry: {
      projectCwd: '/project',
      projectName: 'Demo',
      notebooks: [
        {
          path: '/project/notebooks/real.ipynb',
          relativePath: 'notebooks/real.ipynb',
          name: 'real.ipynb',
          directory: 'notebooks',
          bytes: 2048,
          modifiedAt: '2026-09-09T00:00:00.000Z'
        }
      ],
      truncated: false,
      initialized: true
    },
    onOpenNotebook: () => undefined,
    onRefreshNotebooks: () => undefined,
    onCreateNotebook: () => undefined
  })

  assert.match(markup, /Demo/)
  assert.match(markup, /notebooks\/real\.ipynb/)
  assert.match(markup, /打开 notebooks\/real\.ipynb/)
  assert.match(markup, /刷新 notebooks/)
  assert.match(markup, /新建 notebook/)
  assert.match(markup, /2 KB/)
  assert.doesNotMatch(markup, /data\/raw\/samples\.csv/)
})

test('analysis view renders notebook registry empty and loading states', () => {
  const empty = renderAnalysisView({
    initialLeftPanel: 'notebooks',
    notebookRegistry: {
      projectCwd: '/project',
      projectName: 'Empty',
      notebooks: [],
      truncated: false,
      initialized: false
    },
    onInitializeProjectAnalysis: () => undefined
  })
  const loading = renderAnalysisView({
    initialLeftPanel: 'notebooks',
    notebookRegistry: null,
    isLoadingNotebooks: true
  })

  assert.match(empty, /当前项目还没有 notebook/)
  assert.match(empty, /初始化分析目录/)
  assert.match(loading, /正在扫描 notebooks/)
})

test('analysis view renders an opened notebook document', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: [
      { id: 'intro', cell_type: 'markdown', metadata: {}, source: '# Real notebook\n' },
      {
        id: 'code',
        cell_type: 'code',
        execution_count: 1,
        metadata: {},
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['done\n'] }],
        source: 'real = 1'
      }
    ]
  })
  const markup = renderAnalysisView({
    notebookFile: {
      path: '/project/notebooks/real.ipynb',
      relativePath: 'notebooks/real.ipynb',
      name: 'real.ipynb',
      bytes: 512,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    }
  })

  assert.match(markup, /notebooks\/real\.ipynb/)
  assert.match(markup, /Real notebook/)
  assert.match(markup, /real = 1/)
  assert.match(markup, /done/)
  assert.match(markup, /Saved/)
})

test('analysis view renders artifacts from opened notebook outputs', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: [
      {
        id: 'plot-cell',
        cell_type: 'code',
        execution_count: 2,
        metadata: {},
        outputs: [
          {
            output_type: 'display_data',
            metadata: {},
            data: {
              'text/html': '<div id="real-plot"></div>',
              'text/plain': '<Figure>'
            }
          }
        ],
        source: 'fig'
      }
    ]
  })
  const markup = renderAnalysisView({
    initialInspectorTab: 'artifacts',
    notebookFile: {
      path: '/project/notebooks/real.ipynb',
      relativePath: 'notebooks/real.ipynb',
      name: 'real.ipynb',
      bytes: 512,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    }
  })

  assert.match(markup, /notebooks\/real\.ipynb/)
  assert.match(markup, /plot-cell\.html/)
  assert.match(markup, /HTML/)
  assert.match(markup, /Cell 2/)
  assert.doesNotMatch(markup, /pca\.html/)
  assert.doesNotMatch(markup, /qc_table\.csv/)
})

test('analysis view renders an empty opened notebook as a writable canvas', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: []
  })
  const markup = renderAnalysisView({
    notebookFile: {
      path: '/project/notebooks/empty.ipynb',
      relativePath: 'notebooks/empty.ipynb',
      name: 'empty.ipynb',
      bytes: 128,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    }
  })

  assert.match(markup, /notebooks\/empty\.ipynb/)
  assert.match(markup, /添加 Code cell/)
  assert.match(markup, /添加 Markdown cell/)
  assert.doesNotMatch(markup, /选择或创建 notebook 后开始分析/)
})

test('analysis view renders local kernel diagnostics', () => {
  const markup = renderAnalysisView({
    initialInspectorTab: 'variables',
    kernelDiagnostics: {
      jupyterServer: { available: true, command: 'jupyter', version: '2.14.0' },
      kernels: [
        {
          name: 'python3',
          displayName: 'Python 3',
          language: 'python',
          rawLanguage: 'python'
        }
      ],
      preferredKernelName: 'python3',
      hasPythonKernel: true,
      hasRKernel: false,
      messages: ['未检测到 R kernel。']
    }
  })

  assert.match(markup, /Kernel/)
  assert.match(markup, /Jupyter 2\.14\.0/)
  assert.match(markup, /Python kernel/)
  assert.match(markup, /R missing/)
  assert.match(markup, /未检测到 R kernel/)
})

test('analysis view renders local Jupyter server controls', () => {
  const markup = renderAnalysisView({
    initialInspectorTab: 'variables',
    notebookRegistry: {
      projectCwd: '/project',
      projectName: 'Demo',
      notebooks: [],
      truncated: false,
      initialized: true
    },
    jupyterServerStatus: {
      projectCwd: '/project',
      state: 'stopped',
      hasEndpoint: false,
      message: 'Jupyter Server 已停止'
    },
    onStartJupyterServer: () => undefined,
    onStopJupyterServer: () => undefined,
    onRefreshJupyterServer: () => undefined
  })

  assert.match(markup, /Jupyter server stopped/)
  assert.match(markup, /启动 Jupyter/)
  assert.match(markup, /Jupyter Server 已停止/)
})

test('analysis view renders notebook kernel session controls and status', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: []
  })

  const disconnected = renderAnalysisView({
    initialInspectorTab: 'variables',
    notebookFile: {
      path: '/project/notebooks/real.ipynb',
      relativePath: 'notebooks/real.ipynb',
      name: 'real.ipynb',
      bytes: 512,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    },
    notebookSessionStatus: {
      projectCwd: '/project',
      notebookPath: '/project/notebooks/real.ipynb',
      kernelName: 'python3',
      kernelDisplayName: 'Python 3',
      state: 'disconnected',
      message: 'Notebook 尚未连接 kernel'
    },
    onStartNotebookSession: () => undefined
  })
  const connected = renderAnalysisView({
    initialInspectorTab: 'variables',
    notebookFile: {
      path: '/project/notebooks/real.ipynb',
      relativePath: 'notebooks/real.ipynb',
      name: 'real.ipynb',
      bytes: 512,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    },
    notebookSessionStatus: {
      projectCwd: '/project',
      notebookPath: '/project/notebooks/real.ipynb',
      kernelName: 'python3',
      kernelDisplayName: 'Python 3',
      sessionId: 'session-1',
      state: 'idle',
      message: 'Notebook kernel 已连接'
    },
    onStopNotebookSession: () => undefined
  })

  assert.match(disconnected, /Kernel disconnected/)
  assert.match(disconnected, /连接 kernel/)
  assert.match(disconnected, /Notebook 尚未连接 kernel/)
  assert.match(connected, /Kernel idle/)
  assert.match(connected, /断开/)
  assert.match(connected, /Notebook kernel 已连接/)
})

test('analysis view marks the executing notebook cell as running', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: [{ id: 'code', cell_type: 'code', metadata: {}, source: 'print("running")' }]
  })
  const markup = renderAnalysisView({
    notebookFile: {
      path: '/project/notebooks/real.ipynb',
      relativePath: 'notebooks/real.ipynb',
      name: 'real.ipynb',
      bytes: 512,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    },
    executingNotebookCellId: 'code',
    onRunNotebookCell: () => undefined
  })

  assert.match(markup, /Running/)
  assert.match(markup, /print/)
})

test('analysis view hides placeholder notebook and variables when project kernel is unavailable', () => {
  const markup = renderAnalysisView({
    initialInspectorTab: 'variables',
    notebookRegistry: {
      projectCwd: '/project',
      projectName: 'Demo',
      notebooks: [],
      truncated: false,
      initialized: true
    },
    kernelDiagnostics: {
      jupyterServer: { available: false, command: 'jupyter' },
      kernels: [],
      hasPythonKernel: false,
      hasRKernel: false,
      messages: ['Jupyter 不可用。']
    },
    kernelError: 'Notebook kernel API 尚未加载，请重启 Phi 后再试'
  })

  assert.doesNotMatch(markup, /Saving interactive artifact/)
  assert.doesNotMatch(markup, /Refreshed after Cell 3/)
  assert.match(markup, /选择或创建 notebook 后开始分析/)
  assert.match(markup, /变量检查/)
  assert.match(markup, /请重启 Phi/)
})
