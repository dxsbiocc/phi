import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import FilePreviewPanel, {
  FilePreviewTitleTab,
  ProjectFileTree,
  type FilePreviewPanelState
} from '../src/renderer/src/components/FilePreviewPanel'
import type { DirectoryListing } from '../src/renderer/src/types'

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

function renderPanel(state: FilePreviewPanelState): string {
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
      })
    })
  )
}

test('file preview panel renders file content with line numbers', () => {
  const markup = renderPanel(readyPreviewState)

  assert.match(markup, /aria-label="文件预览"/)
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
  assert.match(markup, /aria-label="显示目录树"/)
  assert.match(markup, /aria-pressed="false"/)
  assert.doesNotMatch(markup, />目录树<\/button>/)
  assert.match(markup, /打开/)
  assert.match(markup, /aria-label="打开方式"/)
  assert.match(markup, />1<\/span>/)
  assert.match(markup, />2<\/span>/)
  assert.match(markup, /const[\s\S]*answer[\s\S]*42/)
  assert.match(markup, /export[\s\S]*default[\s\S]*answer/)
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
