import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import AnalysisView, {
  type AnalysisViewProps
} from '../src/renderer/src/features/analysis/AnalysisView'
import { notebookAiPromptError } from '../src/renderer/src/features/analysis/lib/notebookAiErrors'
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

test('analysis view can embed into the main workspace without its own chat/notebook rail', () => {
  const markup = renderAnalysisView({ hideLeftRail: true })

  assert.match(markup, /No notebook selected/)
  assert.match(markup, /添加 Code cell/)
  assert.doesNotMatch(markup, /当前容器未传入真实聊天面板/)
  assert.doesNotMatch(markup, /调整分析侧栏宽度/)
  assert.doesNotMatch(markup, />Chat</)
  assert.doesNotMatch(markup, />Notebooks</)
})

test('analysis view can hide the right inspector behind the notebook toggle', () => {
  const markup = renderAnalysisView()

  assert.doesNotMatch(markup, /调整检查器宽度/)
  assert.doesNotMatch(markup, /Inspector/)
  assert.doesNotMatch(markup, /data-phi-inspector-toggle-button/)
  assert.doesNotMatch(markup, /data-phi-inspector-toggle-rail/)
  assert.doesNotMatch(markup, /workflows\/main\.nf/)
})

test('analysis view only renders the right inspector when explicitly expanded', () => {
  const markup = renderAnalysisView({ initialInspectorCollapsed: false })

  assert.match(markup, /调整检查器宽度/)
  assert.match(markup, /Files/)
  assert.match(markup, /Variables/)
  assert.match(markup, /Artifacts/)
})

test('analysis view moves top-right chrome controls with the inspector state', () => {
  const controls: AnalysisViewProps['topRightControls'] = ({
    leftSidebarVisible,
    leftSidebarFullscreen,
    inspectorVisible,
    inspectorFullscreen
  }) =>
    createElement(
      'div',
      {
        'data-phi-top-right-controls': 'analysis',
        'data-left-sidebar-visible': String(leftSidebarVisible),
        'data-left-sidebar-fullscreen': String(leftSidebarFullscreen),
        'data-inspector-visible': String(inspectorVisible),
        'data-inspector-fullscreen': String(inspectorFullscreen)
      },
      'chrome controls'
    )
  const expanded = renderAnalysisView({
    initialInspectorCollapsed: false,
    topRightControls: controls
  })
  const collapsed = renderAnalysisView({
    initialInspectorCollapsed: true,
    topRightControls: controls
  })

  assert.ok(
    expanded.indexOf('data-phi-top-right-controls="analysis"') < expanded.indexOf('Files'),
    'expanded inspector renders chrome controls before its tab row'
  )
  assert.match(expanded, /调整检查器宽度/)
  assert.match(expanded, /data-inspector-visible="true"/)
  assert.match(expanded, /data-inspector-fullscreen="false"/)
  assert.match(collapsed, /data-phi-top-right-controls="analysis"/)
  assert.match(collapsed, /data-inspector-visible="false"/)
  assert.doesNotMatch(collapsed, /调整检查器宽度/)
  assert.doesNotMatch(collapsed, /Files/)
})

test('analysis view lets the left sidebar occupy the analysis window', () => {
  const controls: AnalysisViewProps['topRightControls'] = ({
    leftSidebarVisible,
    leftSidebarFullscreen
  }) =>
    createElement('div', {
      'data-phi-top-right-controls': 'analysis',
      'data-left-sidebar-visible': String(leftSidebarVisible),
      'data-left-sidebar-fullscreen': String(leftSidebarFullscreen)
    })
  const markup = renderAnalysisView({
    initialLeftSidebarFullscreen: true,
    topRightControls: controls
  })

  assert.match(markup, /data-left-sidebar-visible="true"/)
  assert.match(markup, /data-left-sidebar-fullscreen="true"/)
  assert.doesNotMatch(markup, /调整分析侧栏宽度/)
  assert.doesNotMatch(markup, /调整检查器宽度/)
  assert.doesNotMatch(markup, /添加 Code cell/)
  assert.doesNotMatch(markup, /Files/)
  assert.doesNotMatch(markup, /Variables/)
  assert.doesNotMatch(markup, /Artifacts/)
})

test('analysis view renders project notebook registry entries', () => {
  const inspectorSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/components/AnalysisInspector.tsx'),
    'utf8'
  )
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
  const withDelete = renderAnalysisView({
    ...props,
    initialInspectorCollapsed: false,
    onDeleteNotebook: () => undefined
  })

  assert.match(markup, /Demo/)
  assert.match(markup, /notebooks\/real\.ipynb/)
  assert.match(markup, /刷新 notebooks/)
  assert.match(markup, /新建 notebook/)
  assert.match(markup, /2 KB/)
  assert.doesNotMatch(markup, /删除 notebooks\/real\.ipynb/)
  assert.match(withDelete, /删除 notebooks\/real\.ipynb/)
  assert.match(inspectorSource, /data-phi-notebook-delete-dialog="true"/)
  assert.match(inspectorSource, /setPendingDeleteNotebook\(\{/)
  assert.doesNotMatch(inspectorSource, /window\.confirm/)
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
    },
    onRefreshKernels: () => undefined
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
  assert.match(markup, /data-phi-notebook-floating-action="save"/)
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

  assert.match(cellSource, /const runCellFromKeyboard =/)
  assert.match(cellSource, /!event\.shiftKey && !event\.metaKey && !event\.ctrlKey/)
  assert.match(cellSource, /onKeyDown=\{runCellFromKeyboard\}/)
  assert.match(codeSource, /event\.shiftKey \|\| event\.metaKey \|\| event\.ctrlKey/)
  assert.match(codeSource, /onRun\?\.\(\)/)
  assert.match(editorSource, /key: 'Shift-Enter'[\s\S]*?return true/)
  assert.match(editorSource, /key: 'Mod-Enter'[\s\S]*?return true/)
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

  assert.match(aiPromptSource, /data-phi-notebook-ai-prompt-cell="true"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-context-menu="true"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-context-menu-placement="above"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-context-layout="compact-preview"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-context-preview="true"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-drag-handle="true"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-generation-status="true"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-generation-model="true"/)
  assert.match(aiPromptSource, /data-phi-notebook-ai-generation-thinking="true"/)
  assert.match(notebookCellSource, /application\/x-phi-notebook-ai-prompt/)
  assert.match(analysisSource, /onMoveAiPrompt=\{onMoveAiPrompt\}/)
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
  assert.match(aiPromptSource, /moveActiveContextOption\(1\)/)
  assert.match(aiPromptSource, /event\.key === 'ArrowUp'/)
  assert.match(aiPromptSource, /moveActiveContextOption\(-1\)/)
  assert.match(aiPromptSource, /event\.key === 'Enter' \|\| event\.key === 'Tab'/)
  assert.match(aiPromptSource, /selectActiveContextOption\(\)/)
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
    /const showAccentShadow = showEditor \|\| isCellSelected \|\| agentHighlighted/
  )
  assert.match(notebookCellSource, /data-phi-notebook-cell-agent-highlighted/)
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
    /const isCodeSelectionChromeOnly = isCodeCell && !agentHighlighted/
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
  assert.match(analysisSource, /notebookSiblingSpacingSelector = \[/)
  assert.match(analysisSource, /data-phi-notebook-cell\] \+ \[data-phi-notebook-ai-prompt-cell/)
  assert.match(analysisSource, /data-phi-notebook-ai-prompt-cell\] \+ \[data-phi-notebook-cell/)
  assert.match(floatingActionsSource, /const notebookFloatingActionInset = 28/)
  assert.match(floatingActionsSource, /data-phi-notebook-floating-actions-inset/)
  assert.match(floatingActionsSource, /data-phi-notebook-floating-actions-position="fixed"/)
  assert.match(floatingActionsSource, /position: 'fixed'/)
  assert.match(analysisSource, /const notebookCanvasRef = useRef<HTMLDivElement \| null>\(null\)/)
  assert.match(analysisSource, /getBoundingClientRect\(\)/)
  assert.match(analysisSource, /window\.innerWidth - rect\.right \+ notebookFloatingActionInset/)
  assert.match(analysisSource, /window\.innerHeight - rect\.bottom \+ notebookFloatingActionInset/)
  assert.match(analysisSource, /pt: \{ xs: 3\.5, md: 3\.75 \}/)
  assert.match(analysisSource, /pb: 16/)
  assert.match(analysisSource, /onGenerateCode=\{openAiPrompt\}/)
  assert.match(analysisSource, /generationStatus=\{aiGenerationStatus\}/)
  assert.match(appSource, /const notebookAiGenerationStatus = useMemo/)
  assert.match(appSource, /activeProject\?\.defaultModel \?\? null/)
  assert.match(appSource, /modelOptionFromSelection\(projectModelSelection, models\)/)
  assert.match(appSource, /selectedModel\?\.name \?\? '自动选择模型'/)
  assert.match(appSource, /notebookAiGenerationStatus=\{notebookAiGenerationStatus\}/)
  assert.match(
    analysisSource,
    /const afterCellId = liveSelectedCellId \?\? cells\.at\(-1\)\?\.id \?\? null/
  )
  assert.match(analysisSource, /setSelectedCellId\(null\)/)
  assert.match(analysisSource, /onSelect=\{\(\) => setSelectedCellId\(null\)\}/)
  assert.match(analysisSource, /references: draft\.references/)
  assert.match(analysisSource, /const generatedCells =/)
  assert.match(analysisSource, /function insertGeneratedNotebookCells/)
  assert.match(analysisSource, /const nextDocument = insertGeneratedNotebookCells/)
  assert.match(
    analysisSource,
    /await saveNotebookDocument\(nextDocument\)[\s\S]*?setDraftDocument\(nextDocument\)[\s\S]*?setAiPromptDraft/
  )
  assert.doesNotMatch(analysisSource, /const \[pendingAiInsertion, setPendingAiInsertion\]/)
  assert.doesNotMatch(aiPromptSource, /data-phi-notebook-ai-staged-insertion/)
  assert.doesNotMatch(aiPromptSource, /data-phi-notebook-ai-staged-message/)
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
  assert.match(analysisSource, /for \(const cell of generatedCells\)/)
  assert.match(analysisSource, /cellType: cell\.cellType/)
  assert.match(analysisSource, /onGenerateNotebookCode\(notebookFile, draftDocument/)
  assert.match(notebookCodeGenerationSource, /NotebookCellsCompletion schema/)
  assert.match(notebookCodeGenerationSource, /marimo notebook completion pattern/)
  assert.match(mainSource, /parseGeneratedNotebookCompletion/)
  assert.match(mainSource, /buildNotebookCodeGenerationPrompt/)
  assert.match(mainSource, /const modelSelection = project\.defaultModel \?\? selectedModel/)
  assert.match(
    mainSource,
    /thinkingLevel: project\.defaultThinkingLevel \?\? selectedThinkingLevel/
  )
  assert.match(notebookCodeGenerationSource, /notebookContextReferencePrompt\(input\.references\)/)
  assert.match(
    mainSource,
    /return \{ source: generatedNotebookCellsSource\(cells\), language, cells \}/
  )
  assert.match(analysisSource, /onSelectCell=\{setSelectedCellId\}/)
  assert.match(
    analysisSource,
    /afterCellId = liveSelectedCellId \?\? cells\.at\(-1\)\?\.id \?\? null/
  )
  assert.doesNotMatch(analysisSource, /notebookAiGeneratedSource/)
  assert.match(analysisRuntimeSource, /const onGenerateAnalysisNotebookCode = useCallback/)
  assert.match(analysisRuntimeSource, /setAnalysisAgentFocus/)
  assert.match(
    analysisRuntimeSource,
    /focusCellId = change\.focusCellId \?\? change\.changedCellId/
  )
  assert.match(analysisSource, /findOutlineCellElement\(agentFocus\.cellId\)\?\.scrollIntoView/)
  assert.match(analysisSource, /setAgentHighlightedCellId\(agentFocus\.cellId\)/)
  assert.match(analysisRuntimeSource, /generateAnalysisNotebookCode\(getActiveCwd\(\), file\.path/)
  assert.match(preloadSource, /ipcRenderer\.invoke\('analysis:generateNotebookCode'/)
  assert.match(mainSource, /ipcMain\.handle\(\s*'analysis:generateNotebookCode'/)
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

  const headerSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/components/NotebookHeader.tsx'),
    'utf8'
  )
  assert.match(headerSource, /kernelOptions\.map\(\(kernel\) =>/)
  assert.match(headerSource, /kernelOptionLabel\(kernel\)/)
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

  assert.match(analysisSource, /const \[pendingKernelSwitch, setPendingKernelSwitch\]/)
  assert.match(analysisSource, /data-phi-notebook-kernel-switch-dialog="true"/)
  assert.match(analysisSource, /data-phi-notebook-kernel-switch-summary="true"/)
  assert.match(analysisSource, /data-phi-notebook-kernel-switch-warning="true"/)
  assert.match(analysisSource, /当前连接的 kernel 会被终止，正在运行的 cell 会停止。/)
  assert.match(analysisSource, /Notebook 的 kernel metadata 会更新，并使用新的 kernel 启动会话。/)
  assert.doesNotMatch(analysisSource, /window\.confirm\(\s*notebookKernelSwitchConfirmationMessage/)
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
    initialInspectorCollapsed: false,
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
    initialInspectorCollapsed: false,
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
    initialInspectorCollapsed: false,
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
    initialInspectorCollapsed: false,
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
    initialInspectorCollapsed: false,
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
  assert.doesNotMatch(disconnected, /aria-label="连接 kernel"/)
  assert.match(disconnected, /Notebook 尚未连接 kernel/)
  assert.match(connected, /Kernel idle/)
  assert.match(connected, /data-phi-notebook-floating-actions="true"/)
  assert.match(connected, /data-phi-notebook-floating-action="disconnect-kernel"/)
  assert.match(connected, /断开/)
  assert.match(connected, /Notebook kernel 已连接/)
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
    onRunNotebookCell: () => undefined
  })

  assert.match(markup, /data-phi-notebook-cell-actions="marimo"/)
  assert.match(markup, /aria-label="停止 cell"/)
  assert.doesNotMatch(markup, /aria-label="运行 cell"/)
  assert.equal(markup.match(/data-phi-notebook-cell-action-surface="opaque"/g)?.length, 2)
  assert.doesNotMatch(markup, /cell 停止待接入 kernel interrupt/)
  assert.match(markup, /data-phi-notebook-cell-execution-duration="[0-9]+ms"/)
  assert.match(markup, /print/)
})

test('analysis view hides placeholder notebook and variables when project kernel is unavailable', () => {
  const markup = renderAnalysisView({
    initialInspectorCollapsed: false,
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
