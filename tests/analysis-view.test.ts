import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import AnalysisView, {
  type AnalysisViewProps
} from '../src/renderer/src/features/analysis/AnalysisView'
import { WorkspaceSidePanel } from '../src/renderer/src/components/WorkspaceSidePanel'
import { notebookAiPromptError } from '../src/renderer/src/features/analysis/lib/notebookAiErrors'
import {
  filterNotebookAiContextOptions,
  notebookAiContextMentionAtCursor,
  notebookAiPromptWithContextReference
} from '../src/renderer/src/features/analysis/lib/notebookAiContextMentions'
import { shouldAutoStartNotebookSession } from '../src/renderer/src/features/analysis/lib/notebookSession'
import {
  displayMimes,
  metadataForMime,
  processNotebookMimeBundle
} from '../src/renderer/src/features/analysis/notebook/notebookOutputUtils'
import { parseNotebook } from '../src/shared/notebookDocument'

function renderAnalysisView(props: AnalysisViewProps = {}): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(ThemeProvider, { theme }, createElement(AnalysisView, props))
  )
}

function renderWorkspaceSidePanel(
  props: Partial<ComponentProps<typeof WorkspaceSidePanel>> = {}
): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(WorkspaceSidePanel, {
        width: 340,
        ...props
      })
    )
  )
}

test('analysis view renders the first-phase notebook shell', () => {
  const markup = renderAnalysisView()

  assert.match(markup, /No notebook selected/)
  assert.match(markup, /当前容器未传入真实聊天面板/)
  assert.match(markup, /调整分析侧栏宽度/)
  assert.match(markup, /添加 Code cell/)
  assert.match(markup, /添加 Markdown cell/)
  assert.doesNotMatch(markup, />分析</)
  assert.doesNotMatch(markup, /调整检查器宽度/)
  assert.doesNotMatch(markup, /Files/)
  assert.doesNotMatch(markup, /Variables/)
  assert.doesNotMatch(markup, /Artifacts/)
  assert.doesNotMatch(markup, /Workspace/)
  assert.doesNotMatch(markup, />Inspector</)
  assert.doesNotMatch(markup, /文件、变量和产物/)
  assert.doesNotMatch(markup, /data-phi-inspector-toggle-button/)
  assert.doesNotMatch(markup, /data-phi-inspector-toggle-rail/)
  assert.doesNotMatch(markup, /notebooks\/exploration\.ipynb/)
  assert.doesNotMatch(markup, /Python 3\.11 demo/)
  assert.doesNotMatch(markup, /Saving interactive artifact/)
  assert.doesNotMatch(markup, /Data Preview/)
  assert.doesNotMatch(markup, /Agent transaction/)
  assert.doesNotMatch(markup, /workflows\/main\.nf/)
  assert.match(markup, /data-phi-notebook-insert-dock="compact"/)
  assert.doesNotMatch(markup, /运行全部 cell/)
  assert.doesNotMatch(markup, /更多 notebook 操作/)
  assert.doesNotMatch(markup, /更多 cell 操作/)
  assert.doesNotMatch(markup, /展开分析侧栏/)
})

test('notebook output mime bundle processing follows marimo-style sorting and hiding rules', () => {
  const bundle = {
    'text/plain': '<altair.Chart>',
    'image/png': 'static-chart',
    'text/html': '<div>html fallback</div>',
    'application/vnd.vegalite.v5+json': {
      $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
      data: { values: [{ x: 1, y: 2 }] },
      width: 'container',
      mark: 'point'
    },
    __metadata__: {
      'application/vnd.vegalite.v5+json': { width: 320, height: 180 },
      ignored: true
    }
  }
  const processed = processNotebookMimeBundle(Object.entries(bundle))

  assert.deepEqual(displayMimes(bundle), ['application/vnd.vegalite.v5+json', 'text/html'])
  assert.deepEqual(processed.hidden.sort(), ['image/png', 'text/plain'])
  assert.deepEqual(
    metadataForMime({
      data: bundle,
      metadata: {
        width: 500,
        'application/vnd.vegalite.v5+json': { width: 640, height: 360 }
      },
      mime: 'application/vnd.vegalite.v5+json'
    }),
    { width: 640, height: 360 }
  )
})

test('notebook AI prompt @ mentions filter and replace context options', () => {
  const options = [
    {
      id: 'dataframe:income_by_country',
      kind: 'dataframe' as const,
      name: 'income_by_country',
      detail: 'pd.read_json("use_data.json")',
      preview: { source: 'pd.read_json("use_data.json")', shape: '2 x 4' }
    },
    {
      id: 'variable:palette',
      kind: 'variable' as const,
      name: 'palette',
      detail: 'in-memory',
      preview: { value: '["#1b9e77", "#d95f02"]' }
    },
    {
      id: 'cell_output:cell-3',
      kind: 'cell_output' as const,
      name: 'cell-3',
      detail: 'output preview',
      preview: { output: 'shape: (284, 3)' }
    }
  ]

  const prompt = 'plot @inc'
  const mention = notebookAiContextMentionAtCursor(prompt, prompt.length)

  assert.deepEqual(mention, { start: 5, end: 9, query: 'inc' })
  assert.equal(notebookAiContextMentionAtCursor('email a@b', 9), null)
  assert.deepEqual(
    filterNotebookAiContextOptions(options, 'inc').map((option) => option.id),
    ['dataframe:income_by_country']
  )
  assert.deepEqual(
    filterNotebookAiContextOptions(options, 'shape').map((option) => option.id),
    ['cell_output:cell-3']
  )
  assert.deepEqual(
    filterNotebookAiContextOptions(options, '2 x').map((option) => option.id),
    ['dataframe:income_by_country']
  )
  assert.equal(
    notebookAiPromptWithContextReference(prompt, mention!, options[0]),
    'plot @income_by_country '
  )
})

test('analysis view can embed into the main workspace without its own chat/notebook rail', () => {
  const markup = renderAnalysisView({ hideLeftRail: true })

  assert.match(markup, /No notebook selected/)
  assert.match(markup, /添加 Code cell/)
  assert.doesNotMatch(markup, /当前容器未传入真实聊天面板/)
  assert.doesNotMatch(markup, /调整分析侧栏宽度/)
  assert.doesNotMatch(markup, />Chat</)
  assert.doesNotMatch(markup, />Notebooks</)
})

test('analysis view does not own the workspace side panel', () => {
  const markup = renderAnalysisView()

  assert.doesNotMatch(markup, /调整检查器宽度/)
  assert.doesNotMatch(markup, /data-phi-workspace-explorer-header="true"/)
  assert.doesNotMatch(markup, /Inspector/)
  assert.doesNotMatch(markup, /data-phi-inspector-toggle-button/)
  assert.doesNotMatch(markup, /data-phi-inspector-toggle-rail/)
  assert.doesNotMatch(markup, /workflows\/main\.nf/)
})

test('terminal side panel shows only the terminal entry', () => {
  const markup = renderWorkspaceSidePanel()

  assert.match(markup, /data-phi-workspace-tools-side-panel="true"/)
  assert.match(markup, /data-phi-workspace-side-panel-mode="terminal"/)
  assert.match(markup, /data-phi-workspace-side-panel-tool-card="terminal"/)
  assert.doesNotMatch(markup, /data-phi-workspace-side-panel-tool-card="browser"/)
  assert.match(markup, /终端/)
  assert.doesNotMatch(markup, /浏览器/)
  assert.doesNotMatch(markup, /data-phi-workspace-explorer-header="true"/)
  assert.doesNotMatch(markup, /刷新文件树/)
  assert.doesNotMatch(markup, /还没有工作空间/)
  assert.doesNotMatch(markup, /Variables/)
  assert.doesNotMatch(markup, /Artifacts/)
  assert.doesNotMatch(markup, /变量检查/)
})

test('browser side panel shows only the browser entry', () => {
  const markup = renderWorkspaceSidePanel({ mode: 'browser' })

  assert.match(markup, /data-phi-workspace-side-panel-mode="browser"/)
  assert.match(markup, /data-phi-workspace-side-panel-tool-card="browser"/)
  assert.doesNotMatch(markup, /data-phi-workspace-side-panel-tool-card="terminal"/)
})

test('workspace side panel shows jobs content instead of tool cards in jobs mode', () => {
  const markup = renderWorkspaceSidePanel({ mode: 'jobs', children: '后台任务列表' })

  assert.match(markup, /data-phi-workspace-side-panel-mode="jobs"/)
  assert.match(markup, /后台任务列表/)
  assert.doesNotMatch(markup, /data-phi-workspace-side-panel-tool-card=/)
})

test('workspace side panel does not render the workspace file tree', () => {
  const markup = renderWorkspaceSidePanel()

  assert.match(markup, /data-phi-workspace-tools-side-panel="true"/)
  assert.doesNotMatch(markup, /aria-label="项目目录树"/)
  assert.doesNotMatch(markup, /筛选文件/)
  assert.doesNotMatch(markup, /data-phi-file-tree-root="true"/)
  assert.doesNotMatch(markup, /正在读取目录/)
  assert.doesNotMatch(markup, /Variables/)
  assert.doesNotMatch(markup, /Artifacts/)
})

test('workspace side panel leaves refresh controls out of the side panel', () => {
  const markup = renderWorkspaceSidePanel()

  assert.match(markup, /data-phi-workspace-tools-side-panel="true"/)
  assert.doesNotMatch(markup, /aria-label="刷新文件树"/)
  assert.doesNotMatch(markup, /aria-label="右侧面板全屏"/)
})

test('analysis view leaves top-right chrome and workspace side panel to app chrome', () => {
  const markup = renderAnalysisView()

  assert.match(markup, /添加 Code cell/)
  assert.doesNotMatch(markup, /data-phi-top-right-controls/)
  assert.doesNotMatch(markup, /data-phi-workspace-explorer-header="true"/)
  assert.doesNotMatch(markup, /调整检查器宽度/)
})

test('analysis view lets the left sidebar occupy the analysis window', () => {
  const markup = renderAnalysisView({
    initialLeftSidebarFullscreen: true
  })

  assert.match(markup, /Chat/)
  assert.match(markup, /Notebooks/)
  assert.doesNotMatch(markup, /data-phi-top-right-controls/)
  assert.doesNotMatch(markup, /调整分析侧栏宽度/)
  assert.doesNotMatch(markup, /调整检查器宽度/)
  assert.doesNotMatch(markup, /添加 Code cell/)
  assert.doesNotMatch(markup, /Files/)
  assert.doesNotMatch(markup, /Variables/)
  assert.doesNotMatch(markup, /Artifacts/)
  assert.doesNotMatch(markup, /Workspace/)
})

test('analysis view renders project notebook registry entries', () => {
  const props: AnalysisViewProps = {
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
  }
  const markup = renderAnalysisView(props)

  assert.match(markup, /Demo/)
  assert.match(markup, /notebooks\/real\.ipynb/)
  assert.match(markup, /刷新 notebooks/)
  assert.match(markup, /新建 notebook/)
  assert.match(markup, /2 KB/)
  assert.doesNotMatch(markup, /删除 notebooks\/real\.ipynb/)
  assert.doesNotMatch(markup, /data\/raw\/samples\.csv/)
})

test('analysis empty notebook canvas offers notebook recovery actions', () => {
  const markup = renderAnalysisView({
    hideLeftRail: true,
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
    onCreateNotebook: () => undefined
  })

  assert.match(markup, /data-phi-notebook-empty-state="true"/)
  assert.match(markup, /data-phi-notebook-empty-options="true"/)
  assert.match(markup, /data-phi-notebook-empty-select="notebooks\/real\.ipynb"/)
  assert.match(markup, /data-phi-notebook-empty-select-icon="jupyter"/)
  assert.match(markup, /data-phi-notebook-empty-create="true"/)
  assert.match(markup, /选择或创建 notebook 后开始分析/)
})

test('analysis notebook selection can open notebooks missing from controlled workspace tabs', () => {
  const analysisSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/AnalysisView.tsx'),
    'utf8'
  )
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

  assert.match(analysisSource, /const matchingWorkspaceTab = workspaceFileTabs\?\.find/)
  assert.match(analysisSource, /onOpenNotebook\(notebook\.absolutePath \?\? notebook\.path\)/)
  assert.match(appSource, /onOpenNotebookWorkspaceFile\(path\)/)
})

test('analysis notebook runtime lets the active workspace open notebooks', () => {
  const runtimeSource = readFileSync(
    resolve(
      process.cwd(),
      'src/renderer/src/features/analysis/hooks/useAnalysisNotebookRuntime.ts'
    ),
    'utf8'
  )

  assert.match(runtimeSource, /const getActiveAnalysisCwd = useCallback/)
  assert.match(
    runtimeSource,
    /onOpenAnalysisNotebook[\s\S]*const cwd = getActiveAnalysisCwd\(\)[\s\S]*if \(!cwd\)[\s\S]*showSnackbar\('请先选择一个 workspace 后再打开 notebook', 'warning'\)[\s\S]*return null/
  )
  assert.match(
    runtimeSource,
    /refreshAnalysisNotebookSessionStatus[\s\S]*const cwd = getActiveAnalysisCwd\(\)[\s\S]*if \(!cwd\)[\s\S]*return/
  )
  assert.match(
    runtimeSource,
    /const status = await rendererApi\.ensureAnalysisNotebookSession\(cwd, file\.path, document\)[\s\S]{0,240}refreshAnalysisJupyterRuntimeStatus\(\)/
  )
  assert.match(runtimeSource, /const read = \+\+analysisNotebookSessionReadRef\.current/)
  assert.match(runtimeSource, /epoch !== analysisNotebookSessionEpochRef\.current/)
  assert.match(
    runtimeSource,
    /refreshAnalysisJupyterRuntimeStatus[\s\S]*const cwd = getActiveAnalysisCwd\(\)[\s\S]*if \(!cwd\)[\s\S]*return/
  )
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
      {
        id: 'intro',
        cell_type: 'markdown',
        metadata: {},
        source: '# Real notebook\n\n## 差异表达数据 `data.json`\n'
      },
      {
        id: 'code',
        cell_type: 'code',
        execution_count: 1,
        metadata: { phi: { executionDurationMs: 1234 } },
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
  assert.match(markup, /data-phi-notebook-file-tabs="true"/)
  assert.match(markup, /data-phi-notebook-file-tab="active"/)
  assert.match(markup, /data-phi-notebook-file-tab-size="compact"/)
  assert.match(markup, /data-phi-notebook-file-tab-icon="jupyter"/)
  assert.match(markup, /data-phi-notebook-file-tab-close="true"/)
  assert.match(markup, /border-radius:999px/)
  assert.match(markup, /data-phi-material-icon="jupyter"/)
  assert.match(markup, /Real notebook/)
  assert.match(markup, /data-phi-syntax-token="plain"/)
  assert.match(markup, /data-phi-syntax-token="operator"/)
  assert.match(markup, /done/)
  assert.match(markup, /data-phi-notebook-save-state="saved"/)
  assert.match(markup, /data-phi-notebook-floating-actions="true"/)
  assert.match(markup, /data-phi-notebook-floating-action="settings"/)
  assert.match(markup, /aria-label="Notebook 设置"/)
  assert.doesNotMatch(markup, /data-phi-notebook-floating-action="refresh-kernels"/)
  assert.match(markup, /data-phi-notebook-outline="true"/)
  assert.match(markup, /data-phi-notebook-outline-popover="true"/)
  assert.match(markup, /data-phi-notebook-outline-hover-bridge="true"/)
  assert.match(markup, /data-phi-notebook-outline-title="rendered-markdown"/)
  assert.match(markup, /data-phi-notebook-insert-language="python"/)
  assert.match(markup, /data-phi-notebook-insert-brand-icon="python"/)
  assert.match(markup, /data-phi-notebook-insert-brand-icon="markdown"/)
  assert.match(markup, /data-phi-material-icon="python"/)
  assert.match(markup, /fill="#0288d1"/)
  assert.match(markup, /fill="#fdd835"/)
  assert.match(markup, /aria-label="添加 Python cell"/)
  assert.match(markup, /data-phi-notebook-insert-action="code"/)
  assert.match(markup, /data-phi-notebook-insert-action="ai"/)
  assert.match(markup, /data-phi-notebook-insert-brand-icon="ai"/)
  assert.match(markup, /aria-label="AI 生成代码"/)
  assert.doesNotMatch(markup, /添加 SQL cell/)
  assert.match(markup, /aria-label="跳转到 Real notebook"/)
  assert.match(markup, /aria-label="跳转到 差异表达数据 data\.json"/)
  assert.match(markup, />data\.json</)
  assert.doesNotMatch(markup, /`data\.json`/)
  assert.equal(markup.match(/data-phi-notebook-outline-marker="true"/g)?.length, 2)
  assert.equal(markup.match(/data-phi-notebook-outline-item="true"/g)?.length, 2)
  assert.equal(markup.match(/data-phi-notebook-scroll-marker="active"/g)?.length, 1)
  assert.equal(markup.match(/data-phi-notebook-scroll-marker="idle"/g)?.length, 1)
  assert.match(markup, /data-phi-notebook-outline-level="1"/)
  assert.match(markup, /data-phi-notebook-outline-level="2"/)
  assert.match(markup, /data-phi-notebook-markdown="rendered"/)
  assert.match(markup, /data-phi-notebook-markdown-edit-trigger="double-click"/)
  assert.match(markup, /data-phi-notebook-markdown-select-trigger="single-click"/)
  assert.match(markup, /data-phi-notebook-cell="marimo-like"/)
  assert.equal(markup.match(/data-phi-notebook-cell-number=/g)?.length, 2)
  assert.match(markup, /data-phi-notebook-cell-number="1"/)
  assert.match(markup, /data-phi-notebook-cell-number="2"/)
  assert.match(markup, /data-phi-notebook-cell-surface="markdown-rendered"/)
  assert.match(markup, /data-phi-notebook-cell-surface="framed"/)
  assert.match(markup, /data-phi-notebook-cell-spacing="roomy"/)
  assert.match(markup, /data-phi-notebook-cell-actions="marimo"/)
  assert.match(markup, /data-phi-notebook-rendered-markdown-action-icon="solid"/)
  assert.match(markup, /aria-label="编辑 Markdown"/)
  assert.match(markup, /aria-label="运行 cell"/)
  assert.doesNotMatch(markup, /连接 kernel 后运行/)
  assert.doesNotMatch(markup, /aria-label="停止 cell"/)
  assert.match(markup, /aria-label="Cell 操作"/)
  assert.equal(markup.match(/data-phi-notebook-cell-action-surface="opaque"/g)?.length, 4)
  assert.match(markup, /aria-label="上方插入 Code cell"/)
  assert.match(markup, /aria-label="下方插入 Code cell"/)
  assert.match(markup, /aria-label="删除 cell"/)
  assert.match(markup, /data-phi-notebook-cell-delete="marimo"/)
  assert.match(markup, /aria-label="拖动 cell"/)
  assert.match(markup, /data-phi-notebook-cell-drag-handle="true"/)
  assert.match(markup, /data-phi-notebook-cell-has-duration="true"/)
  assert.match(markup, /data-phi-notebook-cell-execution-duration="1\.2s"/)
  assert.match(markup, /data-phi-notebook-code="highlighted"/)
  assert.match(markup, /data-phi-syntax-language="python"/)
  assert.match(markup, /data-phi-syntax-token="number"/)
})

test('analysis view hides notebook-local tabs when workspace tabs control files', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: [
      {
        id: 'code',
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: 'answer = 42'
      }
    ]
  })
  const markup = renderAnalysisView({
    hideLeftRail: true,
    notebookFile: {
      path: '/project/notebooks/real.ipynb',
      relativePath: 'notebooks/real.ipynb',
      name: 'real.ipynb',
      bytes: 512,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    },
    workspaceFileTabs: [
      {
        id: '/project/notebooks/real.ipynb',
        path: '/project/notebooks/real.ipynb',
        name: 'real.ipynb',
        status: 'notebooks/real.ipynb',
        absolutePath: '/project/notebooks/real.ipynb'
      }
    ],
    activeWorkspaceFilePath: '/project/notebooks/real.ipynb'
  })

  assert.match(markup, /data-phi-notebook-file-tabs-hidden="true"/)
  assert.doesNotMatch(markup, /data-phi-notebook-file-tabs="true"/)
  assert.match(markup, /data-phi-notebook-code="highlighted"/)
  assert.match(markup, /answer/)
})

test('analysis view renders large notebooks through a virtual cell window', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: Array.from({ length: 30 }, (_, index) => ({
      id: `cell-${index}`,
      cell_type: 'code' as const,
      execution_count: null,
      metadata: {},
      outputs: [],
      source: `value_${index} = ${index}`
    }))
  })
  const markup = renderAnalysisView({
    notebookFile: {
      path: '/project/notebooks/large.ipynb',
      relativePath: 'notebooks/large.ipynb',
      name: 'large.ipynb',
      bytes: 2048,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    }
  })

  assert.match(markup, /data-phi-notebook-virtual-list="true"/)
  assert.match(markup, /data-phi-notebook-virtual-spacer="after"/)
  assert.ok((markup.match(/data-phi-notebook-cell-number=/g)?.length ?? 0) < 30)
  assert.match(markup, /data-phi-notebook-cell-number="1"/)
  assert.doesNotMatch(markup, /data-phi-notebook-cell-number="30"/)
})

test('analysis notebook outline popover is hover-driven, not focus-sticky', () => {
  const source = readFileSync(
    resolve(
      process.cwd(),
      'src/renderer/src/features/analysis/notebook/NotebookScrollProgressRail.tsx'
    ),
    'utf8'
  )

  assert.match(source, /&:hover \.notebook-outline-popover/)
  assert.doesNotMatch(source, /focus-within \.notebook-outline-popover/)
})

test('analysis notebook markdown selection and run affordances use the correct labels', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/notebook/NotebookCell.tsx'),
    'utf8'
  )
  const canvasSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/notebook/NotebookCanvas.tsx'),
    'utf8'
  )

  assert.match(source, /data-phi-notebook-markdown-select-trigger="single-click"/)
  assert.match(source, /data-phi-notebook-rendered-markdown-action-icon="solid"/)
  assert.match(source, /data-phi-notebook-rendered-markdown-actions=/)
  assert.match(source, /solid-hover/)
  assert.match(source, /opacity: menuAnchor \? 1 : 0/)
  assert.doesNotMatch(source, /isRenderedMarkdown \|\| menuAnchor \? 1 : 0/)
  assert.match(source, /&:focus-within/)
  assert.match(source, /编辑 Markdown/)
  assert.match(canvasSource, /isNotebookSessionRunnable\(notebookSessionStatus\)/)
  assert.doesNotMatch(source, /连接 kernel 后运行/)
  assert.doesNotMatch(source, /cell 停止待接入 kernel interrupt/)
})

test('analysis notebook cells reserve shift enter for running code cells', () => {
  const cellSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/notebook/NotebookCell.tsx'),
    'utf8'
  )
  const editorSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/notebook/NotebookCodeEditor.tsx'),
    'utf8'
  )
  const codeSource = readFileSync(
    resolve(
      process.cwd(),
      'src/renderer/src/features/analysis/notebook/NotebookCodeCellSource.tsx'
    ),
    'utf8'
  )
  const canvasSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/notebook/NotebookCanvas.tsx'),
    'utf8'
  )

  assert.match(cellSource, /if \(runAndAdvance\) onAdvanceCell\?\.\(cell\.id\)/)
  assert.match(cellSource, /const runCellFromKeyboard =/)
  assert.match(cellSource, /!event\.shiftKey && !event\.metaKey && !event\.ctrlKey/)
  assert.match(cellSource, /onKeyDown=\{runCellFromKeyboard\}/)
  assert.match(codeSource, /event\.shiftKey \|\| event\.metaKey \|\| event\.ctrlKey/)
  assert.match(codeSource, /onRun\?\.\(\)/)
  assert.match(editorSource, /key: 'Shift-Enter'[\s\S]*?return true/)
  assert.match(editorSource, /key: 'Mod-Enter'[\s\S]*?return true/)
  assert.match(canvasSource, /key === 's'/)
  assert.match(canvasSource, /const runAndAdvance = event\.shiftKey && !mod/)
  assert.match(canvasSource, /setSelectedCellId\(nextCell\.id\)/)
  assert.match(canvasSource, /event\.key === 'ArrowUp' \|\| event\.key === 'ArrowDown'/)
  assert.match(canvasSource, /isNotebookTextEntryShortcutTarget\(target\)/)
  assert.match(canvasSource, /setSelectedCellId\(adjacentCell\.id\)/)
  assert.match(canvasSource, /scrollToNotebookCell\(adjacentCell\.id, 'nearest'\)/)
})

test('analysis view keeps code cell run action available while session status refreshes', () => {
  const analysisSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/notebook/NotebookCanvas.tsx'),
    'utf8'
  )
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: [{ id: 'code', cell_type: 'code', execution_count: null, metadata: {}, outputs: [] }]
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
    onRunNotebookCell: () => undefined
  })

  assert.match(markup, /aria-label="运行 cell"/)
  assert.doesNotMatch(markup, /aria-label="运行 cell"[^>]*disabled/)
  assert.doesNotMatch(markup, /aria-label="连接 kernel 后运行"/)
  assert.doesNotMatch(
    analysisSource,
    /const canRunCells = Boolean\(\s*draftDocument && onRunNotebookCell && isNotebookSessionRunnable\(notebookSessionStatus\)\s*\)/
  )
  assert.match(
    analysisSource,
    /const canRunCells = Boolean\(\s*notebookFile && draftDocument && onRunNotebookCell && !executingCellId\s*\)/
  )
})

test('analysis notebook AI generation opens a positional prompt cell and calls the agent IPC', () => {
  const analysisSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/notebook/NotebookCanvas.tsx'),
    'utf8'
  )
  const notebookViewModelSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/lib/notebookViewModel.ts'),
    'utf8'
  )
  const aiPromptSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/notebook/NotebookAiPromptCell.tsx'),
    'utf8'
  )
  const aiPreviewActionsSource = readFileSync(
    resolve(
      process.cwd(),
      'src/renderer/src/features/analysis/notebook/NotebookAiPreviewActions.tsx'
    ),
    'utf8'
  )
  const notebookCellSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/notebook/NotebookCell.tsx'),
    'utf8'
  )
  const floatingActionsSource = readFileSync(
    resolve(
      process.cwd(),
      'src/renderer/src/features/analysis/notebook/NotebookFloatingActions.tsx'
    ),
    'utf8'
  )
  const notebookCellStylesSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/notebook/notebookCellStyles.ts'),
    'utf8'
  )
  const analysisRuntimeSource = readFileSync(
    resolve(
      process.cwd(),
      'src/renderer/src/features/analysis/hooks/useAnalysisNotebookRuntime.ts'
    ),
    'utf8'
  )
  const preloadSource = readFileSync(resolve(process.cwd(), 'src/preload/index.ts'), 'utf8')
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
  const notebookCodeGenerationSource = readFileSync(
    resolve(process.cwd(), 'src/main/agent/notebook/notebook-code-generation.ts'),
    'utf8'
  )
  const notebookAiPromptDraftSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/lib/notebookAiPromptDraft.ts'),
    'utf8'
  )

  assert.match(aiPromptSource, /data-phi-notebook-ai-prompt-cell="true"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-mode=\{mode\}/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-context-menu="true"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-context-menu-placement="above"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-context-query=\{activeContextQuery/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-context-empty-match="true"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-context-layout="compact-preview"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-context-preview="true"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-drag-handle="true"/)
  assert.doesNotMatch(aiPromptSource, /function NotebookAiStagedCells\(/)
  assert.doesNotMatch(aiPromptSource, /data-phi-notebook-ai-staged-cells="true"/)
  assert.match(aiPreviewActionsSource, /data-phi-notebook-ai-preview-actions="true"/)
  assert.match(aiPreviewActionsSource, /data-phi-notebook-ai-preview-accept="true"/)
  assert.match(aiPreviewActionsSource, /data-phi-notebook-ai-preview-reject="true"/)
  assert.match(aiPreviewActionsSource, /data-phi-notebook-ai-preview-generating="true"/)
  assert.match(analysisSource, /notebookCellsWithAiPreview\(cells, aiPromptDraft/)
  assert.match(analysisSource, /displayCells\.map/)
  assert.match(analysisSource, /provisional=\{isAiPreviewCell\}/)
  assert.doesNotMatch(aiPromptSource, /data-phi-notebook-ai-generation-status="true"/)
  assert.doesNotMatch(aiPromptSource, /data-phi-notebook-ai-generation-model="true"/)
  assert.doesNotMatch(aiPromptSource, /data-phi-notebook-ai-generation-thinking="true"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-model-selector="true"/)
  assert.match(aiPromptSource, /ModelSelectorControl/)
  assert.match(notebookCellSource, /application\/x-phi-notebook-ai-prompt/)
  assert.match(analysisSource, /onMoveAiPrompt=\{isAiPreviewCell \? undefined : onMoveAiPrompt\}/)
  assert.match(analysisSource, /aiPromptDraft\?\.afterCellId === null/)
  assert.match(aiPromptSource, /function NotebookContextPreview\(/)
  assert.match(analysisSource, /buildNotebookAiContextOptions\(cells\)/)
  assert.match(notebookViewModelSource, /notebookOutputPreview\(cell\.outputs\)/)
  assert.match(notebookViewModelSource, /dataframePreviewFromCells\(name, cells, index\)/)
  assert.match(notebookViewModelSource, /const dataframeNames = new Set<string>\(\)/)
  assert.match(notebookViewModelSource, /const dataframeSourcePaths = new Set<string>\(\)/)
  assert.match(notebookViewModelSource, /if \(dataframeNames\.has\(name\)\) continue/)
  assert.match(notebookViewModelSource, /if \(dataframeSourcePaths\.has\(name\)\) continue/)
  assert.match(notebookViewModelSource, /dataframeShapeFromOutputs/)
  assert.match(notebookViewModelSource, /dataframeColumnsFromOutputs/)
  assert.match(notebookViewModelSource, /parseHtmlTable\(htmlText\)/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-context-preview-code=/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-context-preview-output=/)
  assert.match(notebookViewModelSource, /stripHtmlPreview\(raw\)/)
  assert.doesNotMatch(analysisSource, /可作为上下文引用/)
  assert.match(aiPromptSource, /const promptCellRef = useRef<HTMLDivElement \| null>\(null\)/)
  assert.match(aiPromptSource, /document\.addEventListener\('pointerdown'/)
  assert.match(aiPromptSource, /closeContextMenuOnOutsidePointer/)
  assert.match(aiPromptSource, /promptCellRef\.current\?\.contains\(target\)/)
  assert.match(
    aiPromptSource,
    /const contextOptionListRef = useRef<HTMLDivElement \| null>\(null\)/
  )
  assert.match(
    aiPromptSource,
    /const contextOptionRefs = useRef\(new Map<string, HTMLDivElement>\(\)\)/
  )
  assert.match(
    aiPromptSource,
    /const visibleContextOptions = Array\.from\(groupedContextOptions\.values\(\)\)\.flat\(\)/
  )
  assert.match(aiPromptSource, /optionRect\.bottom > listRect\.bottom/)
  assert.match(aiPromptSource, /list\.scrollTop \+= optionRect\.bottom - listRect\.bottom/)
  assert.match(aiPromptSource, /contextOptionRefs\.current\.set\(option\.id, element\)/)
  assert.match(notebookViewModelSource, /from '\.\/notebookHtmlTable'/)
  assert.match(aiPromptSource, /gridTemplateColumns: 'minmax\(0, 210px\) minmax\(0, 1fr\)'/)
  assert.match(aiPromptSource, /bottom: 'calc\(100% \+ 8px\)'/)
  assert.match(aiPromptSource, /overflow: 'visible'/)
  assert.match(aiPromptSource, /onMouseEnter=\{\(\) => setActiveContextOptionId\(option\.id\)\}/)
  assert.match(aiPromptSource, /event\.key === 'ArrowDown'/)
  assert.match(aiPromptSource, /filteredContextOptions\.length > 0/)
  assert.match(aiPromptSource, /notebookAiContextMentionAtCursor\(nextPrompt, nextCursor\)/)
  assert.match(aiPromptSource, /notebookAiPromptWithContextReference/)
  assert.match(aiPromptSource, /moveActiveContextOption\(1\)/)
  assert.match(aiPromptSource, /event\.key === 'ArrowUp'/)
  assert.match(aiPromptSource, /moveActiveContextOption\(-1\)/)
  assert.match(aiPromptSource, /event\.key === 'Enter' \|\| event\.key === 'Tab'/)
  assert.match(aiPromptSource, /selectActiveContextOption\(\)/)
  assert.match(aiPromptSource, /event\.key === 'Enter' &&/)
  assert.match(aiPromptSource, /!event\.shiftKey/)
  assert.match(aiPromptSource, /!event\.nativeEvent\.isComposing/)
  assert.doesNotMatch(
    aiPromptSource,
    /\(event\.metaKey \|\| event\.ctrlKey\) && event\.key === 'Enter'/
  )
  assert.match(aiPromptSource, /hasStagedCells && !isGenerating[\s\S]*?onAccept\(\)/)
  assert.match(aiPromptSource, /event\.key === 'Escape'[\s\S]*?onReject\(\)/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-context-option=\{option\.kind\}/)
  assert.match(analysisSource, /buildNotebookAiContextOptions\(cells\)/)
  assert.match(analysisSource, /references=\{aiPromptDraft\.references\}/)
  assert.match(analysisSource, /contextOptions=\{aiContextOptions\}/)
  assert.match(analysisSource, /onReferenceAdd=\{addAiPromptReference\}/)
  assert.match(aiPromptSource, /onPointerDown=\{onSelect\}/)
  assert.match(aiPromptSource, /onFocusCapture=\{onSelect\}/)
  assert.match(
    notebookViewModelSource,
    /export type NotebookCellAccent = 'markdown' \| 'python' \| 'r' \| 'code' \| 'ai'/
  )
  assert.match(
    notebookCellStylesSource,
    /if \(accent === 'python'\) return theme\.palette\.warning\.main/
  )
  assert.match(notebookCellStylesSource, /if \(accent === 'r'\) return '#276DC3'/)
  assert.match(notebookCellStylesSource, /if \(accent === 'markdown'\) return '#607D8B'/)
  assert.match(
    notebookCellStylesSource,
    /if \(accent === 'ai'\) return theme\.palette\.primary\.main/
  )
  assert.match(notebookViewModelSource, /function notebookCellAccent/)
  assert.match(notebookCellSource, /data-phi-notebook-cell-accent=\{cellAccent\}/)
  assert.match(
    notebookCellSource,
    /data-phi-notebook-cell-selected=\{isCellSelected \? 'true' : undefined\}/
  )
  assert.match(notebookCellSource, /const showEditor = editable && isEditing && isCellSelected/)
  assert.match(
    notebookCellSource,
    /const showAccentShadow = showEditor \|\| isCellSelected \|\| agentHighlighted \|\| provisional/
  )
  assert.match(notebookCellSource, /data-phi-notebook-cell-agent-highlighted/)
  assert.match(notebookCellSource, /data-phi-notebook-cell-provisional/)
  assert.match(notebookCellSource, /const showCellActions = !provisional/)
  assert.match(notebookCellSource, /notebookAccentSelectionShadow\(theme, cellAccent/)
  assert.match(
    notebookCellStylesSource,
    /return notebookAccentBoxShadow\(theme, accent, intensity\)/
  )
  assert.doesNotMatch(notebookCellSource, /0 0 0 2px/)
  assert.doesNotMatch(
    notebookCellSource,
    /'&:focus-within': \{\s+borderColor: \(theme: Theme\) =>\s+alpha\(notebookAccentColor\(theme, cellAccent\)/
  )
  assert.match(notebookCellSource, /if \(isCellSelected\) return alpha\(accentColor, 0\.72\)/)
  assert.match(
    notebookCellSource,
    /const isCodeSelectionChromeOnly = isCodeCell && !agentHighlighted && !provisional/
  )
  assert.match(notebookCellSource, /if \(isCodeSelectionChromeOnly\) return 'transparent'/)
  assert.doesNotMatch(notebookCellSource, /isCodeSelectionChromeOnly\s+\? 'none'/)
  assert.match(notebookCellSource, /boxShadow: \(theme\) =>\s+showEditor/)
  assert.match(notebookCellSource, /if \(isCellSelected\) return alpha\(accentColor, 0\.065\)/)
  assert.match(notebookCellSource, /notebookAccentSelectionShadow\(theme, cellAccent, 0\.18\)/)
  assert.match(notebookCellSource, /notebookAccentSelectionShadow\(theme, cellAccent, 0\.2\)/)
  assert.match(notebookCellSource, /data-phi-notebook-cell-delete="marimo"/)
  assert.match(notebookCellSource, /onPointerDown=\{\(event: PointerEvent<HTMLButtonElement>\) =>/)
  assert.match(notebookCellSource, /onMouseDown=\{\(event: MouseEvent<HTMLButtonElement>\) =>/)
  assert.match(notebookCellSource, /event\.preventDefault\(\)/)
  assert.match(notebookCellSource, /event\.stopPropagation\(\)/)
  assert.match(notebookCellSource, /bottom: -2/)
  assert.match(notebookCellSource, /fontSize: 14/)
  assert.match(notebookCellSource, /bgcolor: 'transparent'/)
  assert.match(notebookCellSource, /disabled=\{isRunning\}/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-accent="ai"/)
  assert.match(aiPromptSource, /notebookAccentBoxShadow\(theme, 'ai'\)/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-prompt-input="true"/)
  assert.match(analysisSource, /notebookSiblingSpacingSelector =/)
  assert.match(analysisSource, /data-phi-notebook-cell\] \+ \[data-phi-notebook-ai-prompt-cell/)
  assert.match(analysisSource, /data-phi-notebook-ai-prompt-cell\] \+ \[data-phi-notebook-cell/)
  assert.match(analysisSource, /data-phi-notebook-cell\] \+ \[data-phi-notebook-ai-preview-actions/)
  assert.match(analysisSource, /data-phi-notebook-ai-preview-actions\] \+ \[data-phi-notebook-cell/)
  assert.match(floatingActionsSource, /const notebookFloatingActionInset = 28/)
  assert.match(floatingActionsSource, /data-phi-notebook-floating-actions-inset/)
  assert.match(floatingActionsSource, /data-phi-notebook-floating-actions-position="fixed"/)
  assert.match(floatingActionsSource, /position: 'fixed'/)
  assert.match(floatingActionsSource, /data-phi-notebook-floating-action="settings"/)
  assert.match(floatingActionsSource, /data-phi-notebook-floating-action="save"/)
  assert.match(floatingActionsSource, /data-phi-notebook-floating-action="format"/)
  assert.match(
    floatingActionsSource,
    /<MenuItem[\s\S]{0,80}data-phi-notebook-floating-action="disconnect-kernel"/
  )
  assert.match(floatingActionsSource, /断开 kernel/)
  assert.doesNotMatch(
    floatingActionsSource,
    /<Fab[\s\S]{0,160}data-phi-notebook-floating-action="disconnect-kernel"/
  )
  assert.match(analysisSource, /const notebookCanvasRef = useRef<HTMLDivElement \| null>\(null\)/)
  assert.match(analysisSource, /getBoundingClientRect\(\)/)
  assert.match(analysisSource, /window\.innerWidth - rect\.right \+ notebookFloatingActionInset/)
  assert.match(analysisSource, /window\.innerHeight - rect\.bottom \+ notebookFloatingActionInset/)
  assert.match(analysisSource, /pt: \{ xs: 3\.5, md: 3\.75 \}/)
  assert.match(analysisSource, /pb: 24/)
  assert.match(analysisSource, /onGenerateCode=\{openAiPrompt\}/)
  assert.match(notebookAiPromptDraftSource, /function acceptStagedNotebookCell/)
  assert.match(notebookAiPromptDraftSource, /function rejectStagedNotebookCell/)
  assert.match(notebookAiPromptDraftSource, /function stageGeneratedNotebookCells/)
  assert.match(notebookAiPromptDraftSource, /function contextReferenceForSelectedCell/)
  assert.match(notebookAiPromptDraftSource, /function shouldIgnoreNotebookAiRefactorShortcut/)
  assert.match(analysisSource, /handleNotebookAiRefactorShortcut/)
  assert.match(analysisSource, /event\.key\.toLowerCase\(\) !== 'e'/)
  assert.match(
    analysisSource,
    /openAiPrompt\(\{ mode: 'refactor', targetCellId: liveSelectedCellId \}\)/
  )
  assert.match(notebookAiPromptDraftSource, /mode: 'insert' \| 'refactor'/)
  assert.match(notebookAiPromptDraftSource, /targetCellId: string \| null/)
  assert.match(analysisSource, /mode=\{aiPromptDraft\.mode\}/)
  assert.match(analysisSource, /modelOptions=\{aiModelOptions \?\? \[\]\}/)
  assert.match(analysisSource, /selectedModel=\{aiPromptDraft\.model\}/)
  assert.match(analysisSource, /hasStagedCells=\{aiPromptDraft\.stagedCells\.length > 0\}/)
  assert.match(analysisSource, /const displayCells = useMemo/)
  assert.match(analysisSource, /const aiPromptSurface = hasAiPreviewCells \? null : aiPromptCell/)
  assert.match(analysisSource, /const previousNotebookDocumentKeyRef = useRef/)
  assert.match(
    analysisSource,
    /const notebookChanged = previousNotebookDocumentKeyRef\.current !== notebookDocumentKey/
  )
  assert.match(analysisSource, /if \(notebookChanged\) setAiPromptDraft\(null\)/)
  assert.match(analysisSource, /onNotebookCodeGenerationProgress/)
  assert.match(analysisSource, /requestId: draft\.id/)
  assert.match(analysisSource, /draft\.isGenerating/)
  assert.match(analysisSource, /onModelChange=\{updateAiPromptModel\}/)
  assert.match(analysisSource, /model: draft\.model/)
  assert.doesNotMatch(analysisSource, /generationStatus=\{/)
  assert.doesNotMatch(appSource, /const notebookAiGenerationStatus = useMemo/)
  assert.match(appSource, /const notebookAiDefaultModel = useMemo/)
  assert.match(appSource, /activeProject\?\.defaultModel \?\? null/)
  assert.match(appSource, /modelOptionFromSelection\(projectModelSelection, models\)/)
  assert.doesNotMatch(appSource, /selectedModel\?\.name \?\? '自动选择模型'/)
  assert.doesNotMatch(appSource, /notebookAiGenerationStatus=\{notebookAiGenerationStatus\}/)
  assert.match(appSource, /notebookAiModelOptions=\{availableModels\}/)
  assert.match(appSource, /notebookAiDefaultModel=\{notebookAiDefaultModel\}/)
  assert.match(
    analysisSource,
    /mode === 'refactor' \? targetCellId : \(liveSelectedCellId \?\? cells\.at\(-1\)\?\.id \?\? null\)/
  )
  assert.match(analysisSource, /setSelectedCellId\(null\)/)
  assert.match(analysisSource, /onSelect=\{\(\) => setSelectedCellId\(null\)\}/)
  assert.match(analysisSource, /references: draft\.references/)
  assert.match(analysisSource, /const generatedCells =/)
  assert.match(analysisSource, /stageGeneratedNotebookCells\(draftDocument, draft/)
  assert.match(analysisSource, /acceptStagedNotebookCell\(/)
  assert.match(analysisSource, /rejectStagedNotebookCell\(current, previewId\)/)
  assert.doesNotMatch(
    analysisSource,
    /insertGeneratedNotebookCells\(draftDocument, draft\.afterCellId/
  )
  assert.doesNotMatch(analysisSource, /replaceNotebookCellWithGeneratedCells/)
  assert.match(analysisSource, /Return replacement notebook cell\(s\) for the selected cell only/)
  const submitAiPromptStart = analysisSource.indexOf('const submitAiPrompt = async')
  const acceptAiPromptStart = analysisSource.indexOf('const acceptAiPreviewCell = useCallback(')
  assert.ok(submitAiPromptStart >= 0)
  assert.ok(acceptAiPromptStart > submitAiPromptStart)
  const submitAiPromptSource = analysisSource.slice(submitAiPromptStart, acceptAiPromptStart)
  assert.doesNotMatch(submitAiPromptSource, /saveNotebookDocument\(nextDocument\)/)
  assert.match(
    analysisSource.slice(acceptAiPromptStart),
    /await saveNotebookDocument\(nextDocument\)/
  )
  assert.match(analysisSource, /onAccept=\{\(\) => \{[\s\S]*?void acceptAiPreviewCell\(cell\.id\)/)
  assert.match(analysisSource, /onReject=\{\(\) => rejectAiPreviewCell\(cell\.id\)\}/)
  assert.match(
    analysisSource,
    /await saveNotebookDocument\(nextDocument\)[\s\S]*?setDraftDocument\(nextDocument\)[\s\S]*?setAiPromptDraft/
  )
  assert.doesNotMatch(analysisSource, /const \[pendingAiInsertion, setPendingAiInsertion\]/)
  assert.doesNotMatch(aiPromptSource, /data-phi-notebook-ai-staged-insertion/)
  assert.doesNotMatch(aiPromptSource, /data-phi-notebook-ai-staged-message/)
  assert.doesNotMatch(aiPromptSource, /data-phi-notebook-ai-staged-cells/)
  assert.doesNotMatch(analysisSource, /pendingGeneratedCells=/)
  assert.doesNotMatch(analysisSource, /confirmationMessage=\{/)
  assert.doesNotMatch(analysisSource, /onConfirmInsertion=/)
  assert.doesNotMatch(analysisSource, /onCancelInsertion=/)
  assert.doesNotMatch(analysisSource, /data-phi-notebook-ai-insert-dialog/)
  assert.doesNotMatch(analysisSource, /setPendingAiInsertion\(/)
  assert.doesNotMatch(analysisSource, /confirmAiInsertion/)
  assert.doesNotMatch(analysisSource, /\{ \.\.\.pending, afterCellId \}/)
  assert.doesNotMatch(analysisSource, /window\.confirm/)
  assert.doesNotMatch(analysisSource, /confirmCellInsertion/)
  assert.doesNotMatch(analysisSource, /notebookCellInsertionConfirmationMessage/)
  assert.match(notebookAiPromptDraftSource, /generatedCells\.map\(\(cell, index\) =>/)
  assert.match(notebookAiPromptDraftSource, /previewId: generatedCellPreviewId\(draft\.id, index\)/)
  assert.match(analysisSource, /onGenerateNotebookCode\(notebookFile, draftDocument/)
  assert.match(notebookCodeGenerationSource, /NotebookCellsCompletion pattern/)
  assert.match(notebookCodeGenerationSource, /Return exactly one JSON object/)
  assert.match(notebookCodeGenerationSource, /Do not include prose outside JSON/)
  assert.match(mainSource, /parseGeneratedNotebookCompletionSnapshot/)
  assert.match(mainSource, /buildNotebookCodeGenerationPrompt/)
  assert.match(
    mainSource,
    /const modelSelection = input\.model \?\? workspace\.project\?\.defaultModel \?\? selectedModel/
  )
  assert.match(
    mainSource,
    /thinkingLevel: workspace\.project\?\.defaultThinkingLevel \?\? selectedThinkingLevel/
  )
  assert.match(notebookCodeGenerationSource, /notebookContextReferencePrompt\(input\.references\)/)
  assert.match(mainSource, /return \{ source, language, cells \}/)
  assert.match(analysisSource, /onSelectCell=\{isAiPreviewCell \? undefined : setSelectedCellId\}/)
  assert.match(
    analysisSource,
    /mode === 'refactor' \? targetCellId : \(liveSelectedCellId \?\? cells\.at\(-1\)\?\.id \?\? null\)/
  )
  assert.doesNotMatch(analysisSource, /notebookAiGeneratedSource/)
  assert.match(analysisRuntimeSource, /const onGenerateAnalysisNotebookCode = useCallback/)
  assert.match(analysisRuntimeSource, /setAnalysisAgentFocus/)
  assert.match(
    analysisRuntimeSource,
    /focusCellId = change\.focusCellId \?\? change\.changedCellId/
  )
  assert.match(analysisSource, /scrollToNotebookCell\(agentFocus\.cellId, 'center'\)/)
  assert.match(analysisSource, /setAgentHighlightedCellId\(agentFocus\.cellId\)/)
  assert.match(analysisRuntimeSource, /generateAnalysisNotebookCode\(getActiveCwd\(\), file\.path/)
  assert.match(preloadSource, /ipcRenderer\.invoke\('analysis:generateNotebookCode'/)
  assert.match(preloadSource, /analysis:notebookCodeGenerationProgress/)
  assert.match(mainSource, /ipcMain\.handle\(\s*'analysis:generateNotebookCode'/)
  assert.match(mainSource, /analysis:notebookCodeGenerationProgress/)
  assert.match(mainSource, /chooseNotebookCompletion/)
  assert.match(mainSource, /noTools: 'all'/)
})

test('analysis notebook AI generation hides Electron IPC wrapper errors from the prompt cell', () => {
  const error = notebookAiPromptError(
    new Error(
      "Error invoking remote method 'analysis:generateNotebookCode': Error: Agent 没有返回可插入的 cell"
    )
  )
  const renderedError = `${error.message}\n${error.detail}`

  assert.equal(error.message, 'AI 没有生成可插入内容，请换一种更具体的描述后重试。')
  assert.equal(error.detail, 'AI 没有生成可插入内容，请换一种更具体的描述后重试。')
  assert.doesNotMatch(renderedError, /Error invoking remote method/)
  assert.doesNotMatch(renderedError, /analysis:generateNotebookCode/)
  assert.doesNotMatch(renderedError, /Agent 没/)

  assert.deepEqual(
    notebookAiPromptError(
      "Error invoking remote method 'analysis:generateNotebookCode': Error: Provider failed"
    ),
    { message: 'Provider failed', detail: 'Provider failed' }
  )
})

test('analysis view exposes detected kernels in the notebook header', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: [{ id: 'code', cell_type: 'code', execution_count: null, metadata: {}, outputs: [] }]
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
    kernelDiagnostics: {
      jupyterServer: { available: true, command: 'jupyter', version: '2.14.0' },
      kernels: [
        {
          name: 'python3',
          displayName: 'Python 3',
          language: 'python',
          rawLanguage: 'python'
        },
        {
          name: 'ir',
          displayName: 'R',
          language: 'r',
          rawLanguage: 'R'
        }
      ],
      preferredKernelName: 'python3',
      hasPythonKernel: true,
      hasRKernel: true,
      messages: []
    }
  })

  assert.match(markup, /data-phi-notebook-kernel-select="true"/)
  assert.match(markup, /data-phi-notebook-kernel-status-dot="primary"/)
  assert.match(markup, /Python 3 \(python3\)/)
  assert.match(markup, /aria-label="Python 3 · not started"/)

  const kernelControlSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/notebook/NotebookKernelControl.tsx'),
    'utf8'
  )
  assert.match(kernelControlSource, /kernelOptions\.map\(\(kernel\) =>/)
  assert.match(kernelControlSource, /kernelOptionLabel\(kernel\)/)
  assert.match(markup, /data-phi-notebook-kernel-control="true"/)

  assert.match(markup, /data-phi-notebook-kernel-icon="python"/)
  assert.match(markup, /data-phi-material-icon="python"/)
})

test('analysis view uses the selected R kernel logo in the notebook header', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'R', language: 'R', name: 'ir' },
      language_info: { name: 'R' }
    },
    cells: [{ id: 'code', cell_type: 'code', execution_count: null, metadata: {}, outputs: [] }]
  })
  const markup = renderAnalysisView({
    notebookFile: {
      path: '/project/notebooks/r-analysis.ipynb',
      relativePath: 'notebooks/r-analysis.ipynb',
      name: 'r-analysis.ipynb',
      bytes: 512,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    },
    kernelDiagnostics: {
      jupyterServer: { available: true, command: 'jupyter', version: '2.14.0' },
      kernels: [{ name: 'ir', displayName: 'R', language: 'r', rawLanguage: 'R' }],
      preferredKernelName: 'ir',
      hasPythonKernel: true,
      hasRKernel: true,
      messages: []
    }
  })

  assert.match(markup, /data-phi-notebook-kernel-select="true"/)
  assert.match(markup, /R \(ir\)/)
  assert.match(markup, /data-phi-notebook-kernel-icon="r"/)
  assert.match(markup, /data-phi-material-icon="r"/)
})

test('analysis view keeps kernel selection available while a notebook kernel is busy or starting', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: [{ id: 'code', cell_type: 'code', execution_count: null, metadata: {}, outputs: [] }]
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
    kernelDiagnostics: {
      jupyterServer: { available: true, command: 'jupyter', version: '2.14.0' },
      kernels: [
        { name: 'python3', displayName: 'Python 3', language: 'python', rawLanguage: 'python' },
        { name: 'ir', displayName: 'R', language: 'r', rawLanguage: 'R' }
      ],
      preferredKernelName: 'python3',
      hasPythonKernel: true,
      hasRKernel: true,
      messages: []
    },
    notebookSessionStatus: {
      projectCwd: '/project',
      notebookPath: '/project/notebooks/real.ipynb',
      kernelName: 'python3',
      kernelDisplayName: 'Python 3',
      sessionId: 'session-1',
      state: 'busy'
    },
    isStartingNotebookSession: true,
    onStartNotebookSession: () => undefined,
    onStopNotebookSession: () => undefined
  })

  assert.match(markup, /data-phi-notebook-kernel-select="true"/)
  assert.doesNotMatch(markup, /data-phi-notebook-kernel-select="true"[^>]*disabled/)
  assert.match(markup, /aria-label="Kernel busy"/)
})

test('analysis view uses an in-app dialog before switching kernels', () => {
  const analysisSource = readFileSync(
    resolve('src/renderer/src/features/analysis/notebook/NotebookCanvas.tsx'),
    'utf8'
  )
  const kernelSwitchDialogSource = readFileSync(
    resolve('src/renderer/src/features/analysis/notebook/NotebookKernelSwitchDialog.tsx'),
    'utf8'
  )

  assert.match(analysisSource, /const \[pendingKernelSwitch, setPendingKernelSwitch\]/)
  assert.match(analysisSource, /<NotebookKernelSwitchDialog/)
  assert.match(kernelSwitchDialogSource, /data-phi-notebook-kernel-switch-dialog="true"/)
  assert.match(kernelSwitchDialogSource, /data-phi-notebook-kernel-switch-summary="true"/)
  assert.match(kernelSwitchDialogSource, /data-phi-notebook-kernel-switch-warning="true"/)
  assert.match(kernelSwitchDialogSource, /当前连接的 kernel 会被终止，正在运行的 cell 会停止。/)
  assert.match(
    kernelSwitchDialogSource,
    /Notebook 的 kernel metadata 会更新，并使用新的 kernel 启动会话。/
  )
  assert.doesNotMatch(analysisSource, /window\.confirm\(\s*notebookKernelSwitchConfirmationMessage/)
})

test('analysis view keeps notebook artifacts out of the workspace explorer', () => {
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
  assert.doesNotMatch(markup, /data-phi-workspace-explorer-header="true"/)
  assert.doesNotMatch(markup, /Workspace/)
  assert.doesNotMatch(markup, /还没有工作空间/)
  assert.doesNotMatch(markup, /plot-cell\.html/)
  assert.doesNotMatch(markup, /Cell 2/)
  assert.doesNotMatch(markup, /pca\.html/)
  assert.doesNotMatch(markup, /qc_table\.csv/)
})

test('analysis view renders notebook outputs by mime type', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: [
      {
        id: 'rich',
        cell_type: 'code',
        execution_count: 3,
        metadata: {},
        source: 'display(outputs)',
        outputs: [
          {
            output_type: 'display_data',
            metadata: {},
            data: {
              'text/html':
                '<div id="real-plot">plot</div><iframe src="plots/local.html"></iframe><img src="figures/local.png">',
              'text/plain': '<Figure>'
            }
          },
          {
            output_type: 'display_data',
            metadata: { 'image/png': { width: 12, height: 8 } },
            data: {
              'image/png':
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axKZJ0AAAAASUVORK5CYII='
            }
          },
          {
            output_type: 'display_data',
            metadata: {},
            data: {
              'image/gif': 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
            }
          },
          {
            output_type: 'display_data',
            metadata: { 'application/pdf': { width: 420, height: 240 } },
            data: {
              'application/pdf': 'JVBERi0xLjQKJcTl8uXrp/Og0MTGCg=='
            }
          },
          {
            output_type: 'display_data',
            metadata: {},
            data: { 'text/markdown': '**metric**: 42' }
          },
          {
            output_type: 'display_data',
            metadata: {},
            data: {
              'application/javascript':
                'element.html(\'<svg id="d3-like"><circle cx="8" cy="8" r="6"></circle></svg>\')',
              'text/plain': '<IPython.core.display.Javascript object>'
            }
          },
          {
            output_type: 'display_data',
            metadata: {},
            data: {
              'text/html': `<div id="altair-html-vis"></div>
                <script type="text/javascript">
                  const spec = {
                    "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
                    "data": { "values": [{ "x": 1, "y": 2 }] },
                    "mark": "circle",
                    "encoding": {
                      "x": { "field": "x", "type": "quantitative" },
                      "y": { "field": "y", "type": "quantitative" }
                    }
                  };
                  vegaEmbed("#altair-html-vis", spec);
                </script>`,
              'text/plain': '<altair.Chart html fallback>'
            }
          },
          {
            output_type: 'display_data',
            metadata: { 'application/vnd.vegalite+json': { width: 480, height: 260 } },
            data: {
              'application/vnd.vegalite+json': {
                $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
                data: { values: [{ x: 1, y: 2 }] },
                width: 'container',
                mark: 'point',
                encoding: {
                  x: { field: 'x', type: 'quantitative' },
                  y: { field: 'y', type: 'quantitative' }
                }
              },
              'text/plain': '<altair.Chart>'
            }
          },
          {
            output_type: 'display_data',
            metadata: { 'application/vnd.plotly.v1+json': { width: 440, height: 280 } },
            data: {
              'application/vnd.plotly.v1+json': {
                data: [{ type: 'scatter', x: [1, 2], y: [3, 4] }],
                layout: { title: { text: 'Plotly chart' } },
                config: { displayModeBar: false }
              },
              'text/html': '<div id="plotly-html-fallback"></div>',
              'text/plain': '<Figure>'
            }
          },
          {
            output_type: 'display_data',
            metadata: {},
            data: {
              'application/x-phi-custom+json': { rendered: false, reason: 'unsupported rich mime' },
              'text/plain': '<Custom object>'
            }
          },
          {
            output_type: 'execute_result',
            execution_count: 3,
            metadata: {},
            data: { 'application/json': { ok: true, rows: 2 } }
          },
          {
            output_type: 'error',
            ename: 'ValueError',
            evalue: 'bad value',
            traceback: ['Traceback line']
          }
        ]
      }
    ]
  })
  const markup = renderAnalysisView({
    notebookFile: {
      path: '/project/notebooks/outputs.ipynb',
      relativePath: 'notebooks/outputs.ipynb',
      name: 'outputs.ipynb',
      bytes: 512,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    }
  })

  assert.match(markup, /data-phi-notebook-output="area"/)
  assert.match(markup, /data-phi-notebook-output-mime-tabs="true"/)
  assert.match(markup, /data-phi-notebook-output-mime-tab="text\/html"/)
  assert.doesNotMatch(markup, /data-phi-notebook-output-mime-tab="text\/plain"/)
  assert.doesNotMatch(markup, /Plain text/)
  assert.match(markup, /data-phi-notebook-output-kind="text\/html"/)
  assert.match(markup, /data-phi-notebook-output-html-frame="true"/)
  assert.match(markup, /data-phi-notebook-output-html-autoheight="true"/)
  assert.match(markup, /data-phi-notebook-output-base-href="file:\/\/\/project\/notebooks\/"/)
  assert.match(
    markup,
    /&lt;base href=&quot;file:\/\/\/project\/notebooks\/&quot; target=&quot;_blank&quot;&gt;/
  )
  assert.match(markup, /phi:notebook-html-output/)
  assert.match(markup, /ResizeObserver/)
  assert.match(markup, /real-plot/)
  assert.match(markup, /plots\/local\.html/)
  assert.match(markup, /figures\/local\.png/)
  assert.match(markup, /data-phi-notebook-output-kind="image\/png"/)
  assert.match(markup, /data-phi-notebook-output-width="12"/)
  assert.match(markup, /data-phi-notebook-output-height="8"/)
  assert.match(markup, /data:image\/png;base64,iVBORw0KGgo/)
  assert.match(markup, /data-phi-notebook-output-kind="image\/gif"/)
  assert.match(markup, /data:image\/gif;base64,R0lGODlhAQABAIA/)
  assert.match(markup, /data-phi-notebook-output-kind="application\/pdf"/)
  assert.match(markup, /data-phi-notebook-output-pdf="true"/)
  assert.match(markup, /data-phi-notebook-output-width="420"/)
  assert.match(markup, /data-phi-notebook-output-height="240"/)
  assert.match(markup, /data:application\/pdf;base64,JVBERi0xLjQK/)
  assert.match(markup, /data-phi-notebook-output-kind="text\/markdown"/)
  assert.match(markup, /metric/)
  assert.match(markup, /data-phi-notebook-output-kind="application\/javascript"/)
  assert.match(markup, /data-phi-notebook-output-javascript-frame="true"/)
  assert.match(markup, /phi-js-output/)
  assert.match(markup, /window\.element/)
  assert.match(markup, /d3-like/)
  assert.doesNotMatch(markup, /altair-html-vis/)
  assert.doesNotMatch(markup, /&lt;altair\.Chart html fallback&gt;/)
  assert.match(markup, /data-phi-notebook-output-kind="application\/vnd\.vegalite\+json"/)
  assert.match(markup, /data-phi-notebook-output-vega="true"/)
  assert.match(markup, /data-phi-notebook-output-width="480"/)
  assert.match(markup, /data-phi-notebook-output-height="260"/)
  assert.match(markup, /data-phi-notebook-output-vega-canvas="true"/)
  assert.match(markup, /data-phi-notebook-output-vega-container-width="true"/)
  assert.match(markup, /data-phi-notebook-output-vega-loading="true"/)
  assert.doesNotMatch(markup, /&lt;altair\.Chart&gt;/)
  assert.match(markup, /data-phi-notebook-output-kind="application\/vnd\.plotly\.v1\+json"/)
  assert.match(markup, /data-phi-notebook-output-active-mime="application\/vnd\.plotly\.v1\+json"/)
  assert.match(markup, /data-phi-notebook-output-mime-tab="application\/vnd\.plotly\.v1\+json"/)
  assert.match(markup, /data-phi-notebook-output-mime-tab="text\/html"/)
  assert.match(markup, /data-phi-notebook-output-plotly="true"/)
  assert.match(markup, /data-phi-notebook-output-width="440"/)
  assert.match(markup, /data-phi-notebook-output-height="280"/)
  assert.match(markup, /data-phi-notebook-output-plotly-canvas="true"/)
  assert.doesNotMatch(markup, /plotly-html-fallback/)
  assert.match(markup, /data-phi-notebook-output-kind="application\/x-phi-custom\+json"/)
  assert.match(markup, /unsupported rich mime/)
  assert.doesNotMatch(markup, /&lt;Custom object&gt;/)
  assert.match(markup, /data-phi-notebook-output-kind="application\/json"/)
  assert.match(markup, /data-phi-notebook-output-toolbar="true"/)
  assert.match(markup, /data-phi-notebook-output-copy="true"/)
  assert.match(markup, /复制输出/)
  assert.match(markup, /&quot;rows&quot;/)
  assert.match(markup, /data-phi-notebook-output-kind="error"/)
  assert.match(markup, /ValueError/)
  assert.doesNotMatch(markup, /&lt;Figure&gt;/)
})

test('analysis view folds long text notebook outputs by default', () => {
  const longOutput = Array.from({ length: 90 }, (_, index) => `line ${index + 1}`).join('\n')
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: [
      {
        id: 'long-output',
        cell_type: 'code',
        execution_count: 6,
        metadata: {},
        source: 'print(long_text)',
        outputs: [{ output_type: 'stream', name: 'stdout', text: longOutput }]
      }
    ]
  })
  const markup = renderAnalysisView({
    notebookFile: {
      path: '/project/notebooks/long.ipynb',
      relativePath: 'notebooks/long.ipynb',
      name: 'long.ipynb',
      bytes: 512,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    }
  })

  assert.match(markup, /data-phi-notebook-output-folded="true"/)
  assert.match(markup, /Output folded: 90 lines/)
  assert.match(markup, /展开完整输出/)
  assert.match(markup, /line 1/)
  assert.doesNotMatch(markup, /line 90/)
})

test('analysis view renders html dataframe outputs as a table surface', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: [
      {
        id: 'dataframe',
        cell_type: 'code',
        execution_count: 4,
        metadata: {},
        source: 'df.head()',
        outputs: [
          {
            output_type: 'execute_result',
            execution_count: 4,
            metadata: {},
            data: {
              'text/html': `
                <div>
                  <table border="1" class="dataframe">
                    <thead>
                      <tr><th></th><th>symbol</th><th>logFC</th><th>sign</th></tr>
                    </thead>
                    <tbody>
                      <tr><th>0</th><td>Apold1</td><td>2.6944</td><td>Up</td></tr>
                      <tr><th>1</th><td>Il7</td><td>-5.848</td><td>Down</td></tr>
                    </tbody>
                  </table>
                </div>
              `,
              'text/plain': '  symbol   logFC  sign\n0 Apold1  2.6944    Up'
            }
          }
        ]
      }
    ]
  })
  const markup = renderAnalysisView({
    notebookFile: {
      path: '/project/notebooks/table.ipynb',
      relativePath: 'notebooks/table.ipynb',
      name: 'table.ipynb',
      bytes: 512,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    }
  })

  assert.match(markup, /data-phi-notebook-output-table="true"/)
  assert.match(markup, /Search\.\.\./)
  assert.match(markup, /Columns/)
  assert.match(markup, /Export/)
  assert.match(markup, /symbol/)
  assert.match(markup, /float64/)
  assert.match(markup, /2 rows, 3 columns/)
  assert.doesNotMatch(markup, /text\/plain/)
})

test('analysis view renders pandas crosstab index and column names correctly', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: [
      {
        id: 'crosstab',
        cell_type: 'code',
        execution_count: 5,
        metadata: {},
        source: 'ct',
        outputs: [
          {
            output_type: 'execute_result',
            execution_count: 5,
            metadata: {},
            data: {
              'text/html': `
                <table border="1" class="dataframe">
                  <thead>
                    <tr><th>sign</th><th>Down</th><th>Up</th><th>total</th></tr>
                    <tr><th>cate</th><th></th><th></th><th></th></tr>
                  </thead>
                  <tbody>
                    <tr><th>X10H - S10H</th><td>195</td><td>274</td><td>469</td></tr>
                    <tr><th>X1H - S1H</th><td>4</td><td>25</td><td>29</td></tr>
                    <tr><th>X20H - S20H</th><td>155</td><td>342</td><td>497</td></tr>
                    <tr><th>X48H - S48H</th><td>280</td><td>1542</td><td>1822</td></tr>
                    <tr><th>X4H - S4H</th><td>505</td><td>360</td><td>865</td></tr>
                    <tr><th>X8H - S8H</th><td>390</td><td>420</td><td>810</td></tr>
                  </tbody>
                </table>
              `,
              'text/plain': 'sign         Down    Up  total'
            }
          }
        ]
      }
    ]
  })
  const markup = renderAnalysisView({
    notebookFile: {
      path: '/project/notebooks/crosstab.ipynb',
      relativePath: 'notebooks/crosstab.ipynb',
      name: 'crosstab.ipynb',
      bytes: 512,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    }
  })

  assert.match(markup, /data-phi-notebook-output-table="true"/)
  assert.match(markup, />cate</)
  assert.match(markup, />Down</)
  assert.match(markup, />Up</)
  assert.match(markup, />total</)
  assert.match(markup, /6 rows, 4 columns/)
  assert.doesNotMatch(markup, />sign</)
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
  assert.match(markup, /data-phi-notebook-insert-language="python"/)
  assert.match(markup, /data-phi-notebook-insert-brand-icon="python"/)
  assert.match(markup, /添加 Python cell/)
  assert.match(markup, /添加 Markdown cell/)
  assert.match(markup, /AI 生成代码/)
  assert.match(markup, /data-phi-notebook-insert-action="ai"/)
  assert.doesNotMatch(markup, /添加 SQL cell/)
  assert.doesNotMatch(markup, /选择或创建 notebook 后开始分析/)
})

test('analysis view renders the insert dock with an R code action for R notebooks', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'R', language: 'R', name: 'ir' },
      language_info: { name: 'R' }
    },
    cells: []
  })
  const markup = renderAnalysisView({
    notebookFile: {
      path: '/project/notebooks/empty-r.ipynb',
      relativePath: 'notebooks/empty-r.ipynb',
      name: 'empty-r.ipynb',
      bytes: 128,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    }
  })

  assert.match(markup, /data-phi-notebook-insert-language="r"/)
  assert.match(markup, /data-phi-notebook-insert-brand-icon="r"/)
  assert.match(markup, /aria-label="添加 R cell"/)
  assert.match(markup, /添加 Markdown cell/)
  assert.match(markup, /AI 生成代码/)
  assert.match(markup, /data-phi-notebook-insert-action="ai"/)
  assert.doesNotMatch(markup, /添加 SQL cell/)
})

test('analysis view renders local kernel diagnostics', () => {
  const markup = renderAnalysisView({
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

  assert.doesNotMatch(markup, /Workspace/)
  assert.doesNotMatch(markup, /Jupyter 2\.14\.0/)
  assert.doesNotMatch(markup, /Python kernel/)
  assert.doesNotMatch(markup, /R missing/)
  assert.doesNotMatch(markup, /未检测到 R kernel/)
})

test('analysis view keeps local Jupyter server controls out of the workspace explorer', () => {
  const markup = renderAnalysisView({
    notebookRegistry: {
      projectCwd: '/project',
      projectName: 'Demo',
      notebooks: [],
      truncated: false,
      initialized: true
    }
  })

  assert.doesNotMatch(markup, /Workspace/)
  assert.doesNotMatch(markup, /data-phi-workspace-explorer-header="true"/)
  assert.doesNotMatch(markup, /Jupyter server stopped/)
  assert.doesNotMatch(markup, /启动 Jupyter/)
  assert.doesNotMatch(markup, /Jupyter Server 已停止/)
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
  assert.doesNotMatch(disconnected, /aria-label="连接 kernel"/)
  assert.match(connected, /Kernel idle/)
  assert.match(connected, /data-phi-notebook-floating-actions="true"/)
  assert.doesNotMatch(connected, /data-phi-notebook-floating-action="disconnect-kernel"/)
  assert.doesNotMatch(connected, /aria-label="断开 kernel"/)
})

test('analysis view auto-starts notebook sessions only when a kernel can be selected', () => {
  const autoConnectKey = '/project/notebooks/real.ipynb:python3'

  assert.equal(
    shouldAutoStartNotebookSession({
      autoConnectKey,
      hasNotebookFile: true,
      hasDocument: true,
      hasStartHandler: true,
      availableKernelCount: 1,
      notebookSessionStatus: {
        projectCwd: '/project',
        notebookPath: '/project/notebooks/real.ipynb',
        kernelName: 'python3',
        kernelDisplayName: 'Python 3',
        state: 'disconnected'
      },
      lastAutoConnectKey: null
    }),
    true
  )
  assert.equal(
    shouldAutoStartNotebookSession({
      autoConnectKey,
      hasNotebookFile: true,
      hasDocument: true,
      hasStartHandler: true,
      availableKernelCount: 1,
      isStartingNotebookSession: true,
      lastAutoConnectKey: null
    }),
    false
  )
  assert.equal(
    shouldAutoStartNotebookSession({
      autoConnectKey,
      hasNotebookFile: true,
      hasDocument: true,
      hasStartHandler: true,
      availableKernelCount: 1,
      notebookSessionStatus: {
        projectCwd: '/project',
        notebookPath: '/project/notebooks/real.ipynb',
        kernelName: 'python3',
        kernelDisplayName: 'Python 3',
        sessionId: 'session-1',
        state: 'idle'
      },
      lastAutoConnectKey: null
    }),
    false
  )
  assert.equal(
    shouldAutoStartNotebookSession({
      autoConnectKey,
      hasNotebookFile: true,
      hasDocument: true,
      hasStartHandler: true,
      availableKernelCount: 1,
      lastAutoConnectKey: autoConnectKey
    }),
    false
  )
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
    onRunNotebookCell: () => undefined,
    onStopNotebookCell: () => undefined
  })

  assert.match(markup, /data-phi-notebook-cell-actions="marimo"/)
  assert.match(markup, /aria-label="停止 cell"/)
  assert.match(markup, /data-phi-notebook-cell-primary-action="stop"/)
  assert.match(markup, /data-phi-notebook-cell-primary-action-enabled="true"/)
  assert.doesNotMatch(markup, /aria-label="运行 cell"/)
  assert.equal(markup.match(/data-phi-notebook-cell-action-surface="opaque"/g)?.length, 2)
  assert.doesNotMatch(markup, /cell 停止待接入 kernel interrupt/)
  assert.match(markup, /data-phi-notebook-cell-execution-duration="[0-9]+ms"/)
  assert.match(markup, /print/)
})

test('analysis view hides placeholder notebook and variables when project kernel is unavailable', () => {
  const markup = renderAnalysisView({
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
  assert.doesNotMatch(markup, /Workspace/)
  assert.doesNotMatch(markup, /data-phi-workspace-explorer-header="true"/)
  assert.doesNotMatch(markup, /变量检查/)
  assert.doesNotMatch(markup, /请重启 Phi/)
})
