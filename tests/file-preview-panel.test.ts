import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement, type ComponentProps, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import FilePreviewPanel, {
  FilePreviewTitleTab,
  ProjectFileTree,
  type FilePreviewPanelState
} from '../src/renderer/src/features/file-preview/FilePreviewPanel'
import {
  parseDelimitedText,
  spreadsheetColumnLabel,
  spreadsheetFormatForPath,
  spreadsheetPreviewModel
} from '../src/renderer/src/lib/spreadsheetPreview'
import type { DirectoryListing } from '../src/renderer/src/types'
import { htmlReportSrcDoc } from '../src/shared/htmlReportPreview'

const readyPreviewState: FilePreviewPanelState = {
  status: 'ready',
  file: {
    path: '/Users/example/project/src/App.tsx',
    name: 'App.tsx',
    displayPath: 'src/App.tsx',
    rootPath: '/Users/example/project',
    rootLabel: 'project',
    kind: 'text',
    mimeType: 'text/plain',
    content: 'const answer = 42\nexport default answer',
    bytes: 39,
    previewBytes: 39,
    truncated: false
  }
}

const directoryPreviewState: FilePreviewPanelState = {
  status: 'directory',
  directory: {
    path: '/Users/example/project/src',
    name: 'src',
    displayPath: 'src',
    rootPath: '/Users/example/project',
    rootLabel: 'project',
    entries: [
      {
        path: '/Users/example/project/src/components',
        name: 'components',
        displayPath: 'src/components',
        kind: 'directory'
      },
      {
        path: '/Users/example/project/src/App.tsx',
        name: 'App.tsx',
        displayPath: 'src/App.tsx',
        kind: 'file'
      }
    ],
    truncated: false
  }
}

function renderWithTheme(element: ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

function renderPanel(
  state: FilePreviewPanelState,
  extras: Partial<ComponentProps<typeof FilePreviewPanel>> = {}
): string {
  return renderWithTheme(
    createElement(FilePreviewPanel, {
      state,
      onOpenFile: () => undefined,
      onOpenDefaultPath: () => undefined,
      onRevealPath: () => undefined,
      onListDirectory: async (): Promise<DirectoryListing> => ({
        path: '/Users/example/project',
        name: 'project',
        displayPath: 'project',
        rootPath: '/Users/example/project',
        rootLabel: 'project',
        entries: [],
        truncated: false
      }),
      ...extras
    })
  )
}

test('file preview panel renders file content with line numbers', () => {
  const markup = renderPanel(readyPreviewState)

  assert.match(markup, /aria-label="文件预览"/)
  assert.match(markup, /data-phi-file-preview-layout="sidecar"/)
  assert.match(markup, /width:66\.666%/)
  assert.match(markup, /flex-basis:66\.666%/)
  assert.match(markup, /max-width:calc\(100% - 320px\)/)
  assert.match(markup, /data-phi-file-kind="react"/)
  assert.match(markup, /aria-label="文件路径：project \/ src \/ App\.tsx"/)
  assert.match(markup, /data-phi-file-preview-content="split"/)
  assert.match(markup, /data-phi-file-preview-pane="file"/)
  assert.match(markup, /data-phi-syntax-language="typescript"/)
  assert.match(markup, /data-phi-syntax-token="keyword"/)
  assert.match(markup, /data-phi-syntax-token="number"/)
  assert.match(markup, /App\.tsx/)
  assert.match(markup, />src<\/span>/)
  assert.doesNotMatch(markup, /aria-label="显示目录树"/)
  assert.doesNotMatch(markup, /aria-pressed="false"/)
  assert.doesNotMatch(markup, />目录树<\/button>/)
  assert.match(markup, /data-phi-file-open-default-button="true"/)
  assert.match(markup, /aria-label="默认应用打开"/)
  assert.match(markup, /data-phi-file-reveal-button="true"/)
  assert.match(markup, /aria-label="文件管理器中显示"/)
  assert.doesNotMatch(markup, /aria-label="打开方式"/)
  assert.doesNotMatch(markup, /aria-haspopup="menu"/)
  assert.match(markup, />1<\/span>/)
  assert.match(markup, />2<\/span>/)
  assert.match(markup, /const[\s\S]*answer[\s\S]*42/)
  assert.match(markup, /export[\s\S]*default[\s\S]*answer/)
})

test('remote HTML stays text and large results show metadata with a download entry', () => {
  const html = renderPanel({
    status: 'ready',
    file: {
      path: 'ssh://cluster-a/scratch/results-a/report.html',
      name: 'report.html',
      displayPath: 'cluster-a/scratch/results-a/report.html',
      rootPath: 'ssh://cluster-a/scratch/results-a',
      rootLabel: 'cluster-a',
      kind: 'text',
      mimeType: 'text/plain',
      content: '<script>alert(1)</script>',
      bytes: 25,
      previewBytes: 25,
      truncated: false
    }
  })
  assert.match(html, /report\.html/)
  assert.doesNotMatch(html, /<script>/)
  const metadata = renderPanel({
    status: 'ready',
    file: {
      path: 'ssh://cluster-a/scratch/results-a/large.pdf',
      name: 'large.pdf',
      displayPath: 'cluster-a/scratch/results-a/large.pdf',
      rootPath: 'ssh://cluster-a/scratch/results-a',
      rootLabel: 'cluster-a',
      kind: 'metadata',
      mimeType: 'application/pdf',
      reason: 'large_file',
      bytes: 12 * 1024 * 1024,
      previewBytes: 0,
      truncated: true
    }
  })
  assert.match(metadata, /12 MB|12\.0 MB|12 MiB/)
  assert.match(metadata, /下载文件/)
  assert.match(metadata, /disabled/)
  assert.doesNotMatch(metadata, /data:application\/pdf;base64/)
})

test('small local HTML reports render in an isolated static frame with a source view', () => {
  const markup = renderPanel({
    status: 'ready',
    file: {
      path: '/Users/example/project/report.html',
      name: 'report.html',
      displayPath: 'report.html',
      rootPath: '/Users/example/project',
      rootLabel: 'project',
      kind: 'html',
      mimeType: 'text/html',
      content: '<h1>QC report</h1><script>alert(1)</script>',
      bytes: 44,
      previewBytes: 44,
      truncated: false
    }
  })
  assert.match(markup, /data-phi-html-report-preview="true"/)
  assert.match(markup, /sandbox=""/)
  assert.match(markup, /Content-Security-Policy/)
  assert.match(markup, /script-src/)
  assert.match(markup, /报告预览/)
  assert.match(markup, /查看源码/)
  assert.doesNotMatch(markup, /<script>alert\(1\)<\/script>/)
})

test('HTML report preview keeps the document doctype and applies restrictions before report markup', () => {
  const document = htmlReportSrcDoc(
    '<!doctype html><html><body><script>alert(1)</script></body></html>'
  )
  assert.match(document, /^<!doctype html><meta http-equiv="Content-Security-Policy"/)
  assert.ok(document.indexOf('script-src') < document.indexOf('<script>'))
  assert.match(document, /connect-src 'none'/)
})

test('remote result download controls show progress, cancellation and the selected saved path', () => {
  const file: FilePreviewPanelState = {
    status: 'ready',
    file: {
      path: 'ssh://cluster-a/scratch/results-a/report.html',
      name: 'report.html',
      displayPath: 'cluster-a/scratch/results-a/report.html',
      rootPath: 'ssh://cluster-a/scratch/results-a',
      rootLabel: 'cluster-a',
      kind: 'text',
      mimeType: 'text/plain',
      content: 'report',
      bytes: 6,
      previewBytes: 6,
      truncated: false
    }
  }
  const readyToDownload = renderPanel(file, { onDownloadFile: () => undefined })
  assert.match(readyToDownload, /aria-label="下载远程文件"/)
  const running = renderPanel(file, {
    onDownloadFile: () => undefined,
    onCancelDownload: () => undefined,
    downloadState: {
      status: 'running',
      requestId: 'download_001',
      sourcePath: file.file.path,
      phase: 'downloading',
      bytesDownloaded: 3,
      totalBytes: 6
    }
  })
  assert.doesNotMatch(running, /aria-label="下载远程文件"/)
  assert.match(running, /aria-label="下载进度"/)
  assert.match(running, /取消下载/)
  assert.match(running, /50%/)
  const saved = renderPanel(file, {
    onDownloadFile: () => undefined,
    downloadState: {
      status: 'saved',
      sourcePath: file.file.path,
      path: '/Users/example/Downloads/report.html',
      bytes: 6,
      remoteDigestVerified: false
    }
  })
  assert.match(saved, /已保存/)
  assert.match(saved, /\/Users\/example\/Downloads\/report\.html/)
  assert.match(saved, /服务器未提供摘要/)
})

test('large remote result metadata enables its explicit download button when connected', () => {
  const markup = renderPanel(
    {
      status: 'ready',
      file: {
        path: 'ssh://cluster-a/scratch/results-a/large.pdf',
        name: 'large.pdf',
        displayPath: 'cluster-a/scratch/results-a/large.pdf',
        rootPath: 'ssh://cluster-a/scratch/results-a',
        rootLabel: 'cluster-a',
        kind: 'metadata',
        mimeType: 'application/pdf',
        reason: 'large_file',
        bytes: 12 * 1024 * 1024,
        previewBytes: 0,
        truncated: true
      }
    },
    { onDownloadFile: () => undefined }
  )
  assert.match(markup, /下载文件/)
  assert.doesNotMatch(markup, /<button[^>]*disabled[^>]*>下载文件<\/button>/)
})

test('remote text preview keeps its SSH identity and replaces local file-manager actions', () => {
  const markup = renderPanel({
    status: 'ready',
    file: {
      path: 'ssh://cluster-a/data/project/note.txt',
      name: 'note.txt',
      displayPath: 'cluster-a/data/project/note.txt',
      rootPath: 'ssh://cluster-a/data/project',
      rootLabel: 'cluster-a',
      kind: 'text',
      mimeType: 'text/plain',
      content: 'remote text',
      bytes: 11,
      previewBytes: 11,
      truncated: false
    }
  })
  assert.match(markup, /文件路径：cluster-a \/ data \/ project \/ note\.txt/)
  assert.match(markup, /复制远程路径/)
  assert.match(markup, /在文件面板打开/)
  assert.match(markup, /在项目文件中定位/)
  assert.doesNotMatch(markup, /默认应用打开|文件管理器中显示/)
  assert.match(markup, /ssh:\/\/cluster-a\/data\/project\/note\.txt/)
})

test('remote loading and error previews keep the server label visible', () => {
  const loading = renderPanel({ status: 'loading', path: 'ssh://cluster-a/data/project/note.txt' })
  const error = renderPanel({
    status: 'error',
    path: 'ssh://cluster-a/data/project/note.txt',
    message: '服务器不可达'
  })
  assert.match(loading, /文件路径：cluster-a \/ note\.txt/)
  assert.match(error, /文件路径：cluster-a \/ note\.txt/)
  assert.match(error, /服务器不可达/)
})

test('file preview panel keeps large json previews lightweight', () => {
  const entries = Array.from(
    { length: 1300 },
    (_, index) => `  {"symbol": "Gene${index}", "logFC": ${index}, "adj.P.Val": 0.01}`
  )
  const content = ['[', ...entries, ']'].join('\n')
  const markup = renderPanel({
    status: 'ready',
    file: {
      path: '/Users/example/project/data.json',
      name: 'data.json',
      displayPath: 'data.json',
      rootPath: '/Users/example/project',
      rootLabel: 'project',
      kind: 'text',
      mimeType: 'text/plain',
      content,
      bytes: 532000,
      previewBytes: 313000,
      truncated: true
    }
  })

  assert.match(markup, /data-phi-syntax-language="json"/)
  assert.match(markup, /data-phi-code-preview-mode="lightweight"/)
  assert.match(markup, /data-phi-code-preview-rendered-lines="1200"/)
  assert.match(markup, /data-phi-code-preview-total-lines="1302"/)
  assert.match(markup, /data-phi-syntax-token="plain"/)
  assert.doesNotMatch(markup, /data-phi-syntax-token="property"/)
  assert.match(markup, />1200<\/span>/)
  assert.doesNotMatch(markup, />1201<\/span>/)
  assert.match(markup, /大文件已使用轻量文本预览/)
  assert.match(markup, /仅渲染前 1,200 行/)
})

test('file preview panel can render as the main workspace file surface', () => {
  const markup = renderWithTheme(
    createElement(FilePreviewPanel, {
      state: readyPreviewState,
      layout: 'workspace',
      onOpenFile: () => undefined,
      onOpenDefaultPath: () => undefined,
      onRevealPath: () => undefined,
      onListDirectory: async (): Promise<DirectoryListing> => ({
        path: '/Users/example/project',
        name: 'project',
        displayPath: 'project',
        rootPath: '/Users/example/project',
        rootLabel: 'project',
        entries: [],
        truncated: false
      })
    })
  )

  assert.match(markup, /data-phi-file-preview-layout="workspace"/)
  assert.match(markup, /width:100%/)
  assert.match(markup, /flex-basis:100%/)
  assert.match(markup, /max-width:none/)
  assert.match(markup, /border-left:0/)
  assert.match(markup, /App\.tsx/)
})

test('file preview panel renders csv files as spreadsheet grids', () => {
  const markup = renderPanel({
    status: 'ready',
    file: {
      path: '/Users/example/project/qc-demo.csv',
      name: 'qc-demo.csv',
      displayPath: 'qc-demo.csv',
      rootPath: '/Users/example/project',
      rootLabel: 'project',
      kind: 'text',
      mimeType: 'text/plain',
      content:
        'sample_id,value_a,value_b,group,flag\nS001,1.75,53,beta,no\n"S,002","3,50",56,gamma,yes',
      bytes: 89,
      previewBytes: 89,
      truncated: false
    }
  })

  assert.match(markup, /data-phi-spreadsheet-preview="true"/)
  assert.match(markup, /data-phi-spreadsheet-format="csv"/)
  assert.match(markup, /data-phi-spreadsheet-name-box="true"/)
  assert.match(markup, /data-phi-spreadsheet-formula-bar="true"/)
  assert.match(markup, /data-phi-spreadsheet-column="A"/)
  assert.match(markup, /data-phi-spreadsheet-column="E"/)
  assert.match(markup, /data-phi-spreadsheet-row="3"/)
  assert.match(markup, /data-phi-spreadsheet-cell="A1"/)
  assert.match(markup, /data-phi-spreadsheet-cell="B2"/)
  assert.match(markup, /sample_id/)
  assert.match(markup, /S,002/)
  assert.match(markup, /3,50/)
  assert.doesNotMatch(markup, /data-phi-syntax-language/)
})

test('file preview panel renders PDB files with a Molstar structure preview and source text', () => {
  const markup = renderPanel({
    status: 'ready',
    file: {
      path: '/Users/example/project/structures/1tup.pdb',
      name: '1tup.pdb',
      displayPath: 'structures/1tup.pdb',
      rootPath: '/Users/example/project',
      rootLabel: 'project',
      kind: 'text',
      mimeType: 'text/plain',
      content:
        'HEADER    DNA BINDING PROTEIN                     11-JUL-95   1TUP\nATOM      1  N   SER A   1      37.667  28.688  54.322  1.00 40.83           N',
      bytes: 144,
      previewBytes: 144,
      truncated: false
    }
  })

  assert.match(markup, /data-phi-molecular-structure-file-preview="true"/)
  assert.match(markup, /data-phi-molecular-structure-format="pdb"/)
  assert.match(markup, /Mol\*/)
  assert.match(markup, /正在加载 Mol\* 结构预览/)
  assert.match(markup, /data-phi-syntax-language="plain"/)
  assert.match(markup, /DNA BINDING PROTEIN/)
  assert.match(markup, /ATOM/)
})

test('file preview panel renders tsv files as spreadsheet grids', () => {
  const markup = renderPanel({
    status: 'ready',
    file: {
      path: '/Users/example/project/example.tsv',
      name: 'example.tsv',
      displayPath: 'example.tsv',
      rootPath: '/Users/example/project',
      rootLabel: 'project',
      kind: 'text',
      mimeType: 'text/plain',
      content: 'x\ty\n10.0\t8.04',
      bytes: 13,
      previewBytes: 13,
      truncated: false
    }
  })

  assert.match(markup, /data-phi-spreadsheet-preview="true"/)
  assert.match(markup, /data-phi-spreadsheet-format="tsv"/)
  assert.match(markup, /data-phi-spreadsheet-column="B"/)
  assert.match(markup, /data-phi-spreadsheet-cell="B2"/)
  assert.match(markup, /8\.04/)
})

test('spreadsheet preview model parses delimited text without UI coupling', () => {
  assert.deepEqual(parseDelimitedText('name,value\n"S,002","3,50"', ','), [
    ['name', 'value'],
    ['S,002', '3,50']
  ])
  assert.equal(spreadsheetFormatForPath('/tmp/example.tab'), 'tsv')
  assert.equal(spreadsheetColumnLabel(26), 'AA')
  assert.equal(
    spreadsheetPreviewModel({
      path: '/tmp/readme.md',
      name: 'readme.md',
      displayPath: 'readme.md',
      rootPath: '/tmp',
      rootLabel: 'tmp',
      kind: 'text',
      mimeType: 'text/markdown',
      content: '# Readme',
      bytes: 8,
      previewBytes: 8,
      truncated: false
    }),
    null
  )
})

test('file preview panel renders png image previews', () => {
  const markup = renderPanel({
    status: 'ready',
    file: {
      path: '/Users/example/project/plot.png',
      name: 'plot.png',
      displayPath: 'plot.png',
      rootPath: '/Users/example/project',
      rootLabel: 'project',
      kind: 'image',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      bytes: 8,
      previewBytes: 8,
      truncated: false
    }
  })

  assert.match(markup, /data-phi-media-preview="image"/)
  assert.match(markup, /src="data:image\/png;base64,iVBORw0KGgo="/)
  assert.match(markup, /alt="plot\.png"/)
  assert.doesNotMatch(markup, /data-phi-syntax-language/)
})

test('file preview panel renders JPEG, GIF, and WebP images in the same media viewer', () => {
  for (const [name, mimeType] of [
    ['photo.jpg', 'image/jpeg'],
    ['animation.gif', 'image/gif'],
    ['chart.webp', 'image/webp']
  ] as const) {
    const markup = renderPanel({
      status: 'ready',
      file: {
        path: `/Users/example/project/${name}`,
        name,
        displayPath: name,
        rootPath: '/Users/example/project',
        rootLabel: 'project',
        kind: 'image',
        mimeType,
        dataUrl: `data:${mimeType};base64,YQ==`,
        bytes: 1,
        previewBytes: 1,
        truncated: false
      }
    })
    assert.match(markup, /data-phi-media-preview="image"/)
    assert.match(markup, new RegExp(`src="data:${mimeType};base64,YQ=="`))
    assert.match(markup, new RegExp(`alt="${name.replace('.', '\\.')}"`))
  }
})

test('file preview panel renders pdf previews', () => {
  const markup = renderPanel({
    status: 'ready',
    file: {
      path: '/Users/example/project/report.pdf',
      name: 'report.pdf',
      displayPath: 'report.pdf',
      rootPath: '/Users/example/project',
      rootLabel: 'project',
      kind: 'pdf',
      mimeType: 'application/pdf',
      dataUrl: 'data:application/pdf;base64,JVBERi0=',
      bytes: 8,
      previewBytes: 8,
      truncated: false
    }
  })

  assert.match(markup, /data-phi-media-preview="pdf"/)
  assert.match(markup, /src="data:application\/pdf;base64,JVBERi0="/)
  assert.match(markup, /aria-label="PDF 预览：report\.pdf"/)
  assert.doesNotMatch(markup, /data-phi-syntax-language/)
})

test('file preview title tab renders in the top split area', () => {
  const markup = renderWithTheme(
    createElement(FilePreviewTitleTab, {
      state: readyPreviewState,
      onClose: () => undefined
    })
  )

  assert.match(markup, /role="tab"/)
  assert.match(markup, /aria-selected="true"/)
  assert.match(markup, /aria-label="当前文件：App\.tsx"/)
  assert.match(markup, /width:66\.666%/)
  assert.match(markup, /flex-basis:66\.666%/)
  assert.match(markup, /max-width:calc\(100% - 320px\)/)
  assert.match(markup, /align-items:center/)
  assert.match(markup, /height:32px/)
  assert.match(markup, /border-radius:8px/)
  assert.match(markup, /data-phi-file-kind="react"/)
  assert.match(markup, /App\.tsx/)
  assert.match(markup, /aria-label="关闭文件预览"/)
})

test('file preview path tooltips are attached to text labels, not blank titlebar rows', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/file-preview/FilePreviewPanel.tsx'),
    'utf8'
  )
  const titleTabSource = source.slice(
    source.indexOf('export function FilePreviewTitleTab'),
    source.indexOf('function FilePathBreadcrumb')
  )
  const breadcrumbSource = source.slice(
    source.indexOf('function FilePathBreadcrumb'),
    source.indexOf('function FilePreviewActions')
  )

  assert.doesNotMatch(
    titleTabSource,
    /<Tooltip title=\{path\}[\s\S]{0,160}<Box[\s\S]{0,80}role="tab"/
  )
  assert.match(titleTabSource, /<Tooltip title=\{path\}[\s\S]{0,160}<Typography/)
  assert.match(titleTabSource, /maxWidth: 'calc\(100% - 48px\)'/)
  assert.doesNotMatch(
    breadcrumbSource,
    /<Tooltip title=\{fullPath\}[\s\S]{0,160}<Box[\s\S]{0,80}aria-label=\{`文件路径/
  )
  assert.match(breadcrumbSource, /<Tooltip title=\{fullPath\}[\s\S]{0,160}<Typography/)
})

test('file preview default open action uses the system file icon without a menu', () => {
  const panelSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/file-preview/FilePreviewPanel.tsx'),
    'utf8'
  )
  const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
  const preloadSource = readFileSync(resolve(process.cwd(), 'src/preload/index.ts'), 'utf8')
  const preloadTypes = readFileSync(resolve(process.cwd(), 'src/preload/index.d.ts'), 'utf8')
  const rendererTypes = readFileSync(resolve(process.cwd(), 'src/renderer/src/types.ts'), 'utf8')

  assert.match(panelSource, /window\.api[\s\S]{0,120}\.getFileIcon\(path\)/)
  assert.match(panelSource, /data-phi-file-open-default-app-icon="system"/)
  assert.doesNotMatch(panelSource, /MenuItem/)
  assert.doesNotMatch(panelSource, /aria-label="打开方式"/)
  assert.match(mainSource, /ipcMain\.handle\('files:getIcon'/)
  assert.match(mainSource, /com\.apple\.launchservices\.secure\.plist/)
  assert.match(mainSource, /\/usr\/bin\/mdfind/)
  assert.match(
    mainSource,
    /macFallbackApplicationBundleIdByExtension[\s\S]*png: 'com\.apple\.preview'/
  )
  assert.match(mainSource, /getMacApplicationIconDataUrl\(bundleId\)/)
  assert.match(
    preloadSource,
    /getFileIcon: \(path: string\): Promise<string \| null> => ipcRenderer\.invoke\('files:getIcon', path\)/
  )
  assert.match(preloadTypes, /getFileIcon: \(path: string\) => Promise<string \| null>/)
  assert.match(rendererTypes, /getFileIcon: \(path: string\) => Promise<string \| null>/)
})

test('file preview title tab can reserve fixed app chrome space', () => {
  const markup = renderWithTheme(
    createElement(FilePreviewTitleTab, {
      state: readyPreviewState,
      titlebarInsetStart: '172px',
      titlebarInsetEnd: '120px',
      onClose: () => undefined
    })
  )

  assert.match(markup, /padding-left:172px/)
  assert.match(markup, /padding-right:120px/)
  assert.match(markup, /aria-label="关闭文件预览"/)
})

test('file preview title tab renders directories distinctly', () => {
  const markup = renderWithTheme(
    createElement(FilePreviewTitleTab, {
      state: directoryPreviewState,
      onClose: () => undefined
    })
  )

  assert.match(markup, /aria-label="当前目录：src"/)
  assert.match(markup, /data-phi-file-kind="directory"/)
  assert.match(markup, /src/)
})

test('project file tree renders as a right-side sidebar', () => {
  const emptyListing: DirectoryListing = {
    path: '/Users/example/project',
    name: 'project',
    displayPath: 'project',
    rootPath: '/Users/example/project',
    rootLabel: 'project',
    entries: [],
    truncated: false
  }
  const markup = renderWithTheme(
    createElement(ProjectFileTree, {
      rootPath: '/Users/example/project',
      activePath: '/Users/example/project/src/App.tsx',
      initialListing: emptyListing,
      onOpenFile: () => undefined,
      onListDirectory: async (): Promise<DirectoryListing> => ({
        path: '/Users/example/project',
        name: 'project',
        displayPath: 'project',
        rootPath: '/Users/example/project',
        rootLabel: 'project',
        entries: [],
        truncated: false
      })
    })
  )

  assert.match(markup, /aria-label="项目目录树"/)
  assert.match(markup, /height:100%/)
  assert.match(markup, /flex:0 0 clamp\(240px, 30%, 320px\)/)
  assert.match(markup, /max-width:42%/)
  assert.match(markup, /border-left:1px solid/)
  assert.doesNotMatch(markup, /border-bottom:1px solid/)
  assert.match(markup, /placeholder="筛选文件\.\.\."/)
  assert.match(markup, /data-phi-file-tree-root="true"/)
  assert.match(markup, /aria-expanded="true"/)
  assert.match(markup, /文件夹为空/)
})

test('file preview panel renders clicked directories as the main right-side tree', () => {
  const markup = renderPanel(directoryPreviewState)

  assert.match(markup, /aria-label="文件预览"/)
  assert.match(markup, /data-phi-file-kind="directory"/)
  assert.match(markup, /data-phi-file-preview-content="directory"/)
  assert.match(markup, /data-phi-file-preview-pane="directory"/)
  assert.match(markup, /aria-label="项目目录树"/)
  assert.match(markup, /flex:1 1 auto/)
  assert.match(markup, /max-width:none/)
  assert.match(markup, /border-left:0/)
  assert.match(markup, /aria-label="文件路径：project \/ src"/)
  assert.match(markup, /data-phi-file-tree-root="true"/)
  assert.match(markup, />src<\/span>/)
  assert.match(markup, /components/)
  assert.match(markup, /App\.tsx/)
  assert.doesNotMatch(markup, /aria-label="显示目录树"/)
  assert.doesNotMatch(markup, />目录树<\/button>/)
  assert.doesNotMatch(markup, /正在读取文件/)
})

test('file preview panel makes empty clicked directories explicit', () => {
  const markup = renderPanel({
    status: 'directory',
    directory: {
      path: '/Users/example/project/workspace',
      name: 'workspace',
      displayPath: 'workspace',
      rootPath: '/Users/example/project',
      rootLabel: 'project',
      entries: [],
      truncated: false
    }
  })

  assert.match(markup, /data-phi-file-preview-content="directory"/)
  assert.match(markup, /data-phi-file-tree-root="true"/)
  assert.match(markup, />workspace<\/span>/)
  assert.match(markup, /data-phi-file-tree-empty="true"/)
  assert.match(markup, /文件夹为空/)
})

test('file preview panel shows loading, errors, and truncation', () => {
  assert.match(renderPanel({ status: 'loading', path: '/tmp/App.tsx' }), /正在读取文件/)
  assert.match(
    renderPanel({ status: 'loading', path: '/tmp/project/src', pathKind: 'directory' }),
    /正在读取目录/
  )
  assert.match(
    renderPanel({ status: 'error', path: '/tmp/App.tsx', message: '不能预览' }),
    /不能预览/
  )
  assert.match(
    renderPanel({
      status: 'ready',
      file: {
        path: '/tmp/large.txt',
        name: 'large.txt',
        displayPath: 'large.txt',
        rootPath: '/tmp',
        rootLabel: 'tmp',
        kind: 'text',
        mimeType: 'text/plain',
        content: 'preview',
        bytes: 4096,
        previewBytes: 7,
        truncated: true
      }
    }),
    /文件较大，已预览前 7 B \/ 4\.0 KB/
  )
})
