import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { ToolCallDetail } from '../src/renderer/src/components/ToolCallCard'
import {
  INLINE_OUTPUT_PREVIEW_CHARS,
  PERSISTED_OUTPUT_PREVIEW_CHARS,
  TOOL_ARGS_PREVIEW_CHARS,
  formatBytes,
  isOutputPreviewTruncated,
  isToolArgsPreviewTruncated,
  outputPreviewText,
  stripSavedOutputMarker
} from '../src/renderer/src/lib/toolOutputPresentation'
import type { ToolCallItem } from '../src/renderer/src/types'

test('tool output presentation strips persisted-output storage marker', () => {
  const output =
    'first lines\n...（完整输出已保存到 /Users/example/.phi/sessions/a/tool-outputs/run-tool.txt）'

  assert.equal(stripSavedOutputMarker(output), 'first lines')
})

test('tool output presentation keeps persisted output previews compact', () => {
  const outputPath = '/Users/example/.phi/sessions/a/tool-outputs/run-tool.txt'
  const preview = outputPreviewText({
    output: `${'a'.repeat(PERSISTED_OUTPUT_PREVIEW_CHARS + 100)}\n...（完整输出已保存到 ${outputPath}）`,
    outputPath,
    outputTruncated: true
  })

  assert.ok(preview.length < PERSISTED_OUTPUT_PREVIEW_CHARS + 20)
  assert.match(preview, /预览已截断/)
  assert.doesNotMatch(preview, /完整输出已保存到/)
})

test('tool output presentation detects visually truncated previews', () => {
  assert.equal(isOutputPreviewTruncated({ output: 'short' }), false)
  assert.equal(
    isOutputPreviewTruncated({ output: 'a'.repeat(INLINE_OUTPUT_PREVIEW_CHARS + 1) }),
    true
  )
  assert.equal(isToolArgsPreviewTruncated('{"cmd":"pwd"}'), false)
  assert.equal(isToolArgsPreviewTruncated('a'.repeat(TOOL_ARGS_PREVIEW_CHARS + 1)), true)
})

test('tool output presentation formats byte sizes for labels', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB')
})

test('tool detail surfaces saved output before the compact preview', () => {
  const item: ToolCallItem = {
    id: 'tool-1',
    role: 'tool',
    toolName: 'shell',
    argsPreview: 'npm test',
    argsJson: '{"cmd":"npm test"}',
    output:
      'short preview\n...（完整输出已保存到 /Users/example/.phi/sessions/a/tool-outputs/run-tool.txt）',
    outputPath: '/Users/example/.phi/sessions/a/tool-outputs/run-tool.txt',
    outputBytes: 2048,
    outputTruncated: true,
    status: 'done'
  }
  const markup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, createElement(ToolCallDetail, { item }))
  )

  assert.match(markup, /完整输出已保存/)
  assert.match(markup, /在文件夹显示/)
  assert.match(markup, /输出预览 · 2.0 KB · 已截断/)
  assert.match(markup, /short preview/)
  assert.doesNotMatch(markup, /完整输出已保存到/)
})

test('hosted PubMed fetch detail shows the decoded search terms', () => {
  const item: ToolCallItem = {
    id: 'fetch-1',
    role: 'tool',
    toolName: 'web_fetch',
    argsPreview: 'https://pubmed.ncbi.nlm.nih.gov/?term=MID1IP1+OR+Mig12',
    argsJson: JSON.stringify({ url: 'https://pubmed.ncbi.nlm.nih.gov/?term=MID1IP1+OR+Mig12' }),
    output: 'results',
    status: 'done'
  }
  const markup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, createElement(ToolCallDetail, { item }))
  )
  assert.match(markup, /检索词/)
  assert.match(markup, /MID1IP1 OR Mig12/)
})

test('tool detail surfaces database viewer hints before raw DB JSON', () => {
  const item: ToolCallItem = {
    id: 'tool-1',
    role: 'tool',
    toolName: 'db_query',
    argsPreview: 'db_query',
    argsJson: '{"database":"rest-json/toy","domain":"compound"}',
    output: JSON.stringify({
      kind: 'db_query_result',
      mode: 'inline',
      summary: {
        rowCount: 1,
        returnedRows: 1,
        truncated: false,
        fields: ['canonical_smiles'],
        warnings: []
      },
      rows: [{ canonical_smiles: 'CCO' }],
      viewerHints: [
        {
          kind: 'small_molecule',
          label: '小分子结构',
          recommendedLibrary: 'rdkit-js',
          confidence: 'high',
          rowCount: 1,
          fields: ['canonical_smiles'],
          sampleValues: ['CCO'],
          reason: 'matched fields: canonical_smiles'
        }
      ],
      provenance: {
        database: 'rest-json/toy',
        domain: 'compound',
        retrievedAt: '2026-09-20T00:00:00.000Z'
      }
    }),
    status: 'done'
  }
  const markup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, createElement(ToolCallDetail, { item }))
  )

  assert.match(markup, /数据库结果展示/)
  assert.match(markup, /小分子结构/)
  assert.match(markup, /RDKit\.js/)
  assert.match(markup, /data-phi-molecule-expression="true"/)
  assert.match(markup, /CCO/)
  assert.match(markup, /canonical_smiles/)
})

test('tool detail does not send InChI-only molecule hints to RDKit rendering', () => {
  const item: ToolCallItem = {
    id: 'tool-1',
    role: 'tool',
    toolName: 'db_query',
    argsPreview: 'db_query',
    argsJson: '{"database":"rest-json/toy","domain":"compound"}',
    output: JSON.stringify({
      kind: 'db_query_result',
      mode: 'inline',
      summary: {
        rowCount: 1,
        returnedRows: 1,
        truncated: false,
        fields: ['inchi'],
        warnings: []
      },
      rows: [{ inchi: 'InChI=1S/H2O/h1H2' }],
      viewerHints: [
        {
          kind: 'small_molecule',
          label: '小分子结构',
          recommendedLibrary: 'rdkit-js',
          confidence: 'high',
          rowCount: 1,
          fields: ['inchi'],
          sampleValues: ['InChI=1S/H2O/h1H2'],
          reason: 'matched fields: inchi'
        }
      ],
      provenance: {
        database: 'rest-json/toy',
        domain: 'compound',
        retrievedAt: '2026-09-20T00:00:00.000Z'
      }
    }),
    status: 'done'
  }
  const markup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, createElement(ToolCallDetail, { item }))
  )

  assert.match(markup, /小分子结构/)
  assert.match(markup, /没有可渲染的小分子结构字段/)
  assert.doesNotMatch(markup, /正在加载 RDKit\.js/)
})

test('tool detail surfaces edit and write targets before raw args', () => {
  const item: ToolCallItem = {
    id: 'tool-1',
    role: 'tool',
    toolName: 'edit',
    argsPreview: './src/App.tsx',
    argsJson: '{"path":"./src/App.tsx","oldText":"a","newText":"b"}',
    output: '',
    status: 'done'
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ToolCallDetail, { item, cwd: '/Users/example/project' })
    )
  )

  assert.match(markup, /目标文件/)
  assert.match(markup, /title="\/Users\/example\/project\/src\/App.tsx"/)
  assert.match(markup, /在文件夹显示/)
  assert.match(markup, /参数/)
})

test('tool detail does not show target actions for non-file tools', () => {
  const item: ToolCallItem = {
    id: 'tool-1',
    role: 'tool',
    toolName: 'shell',
    argsPreview: './src/App.tsx',
    argsJson: '{"path":"./src/App.tsx"}',
    output: '',
    status: 'done'
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ToolCallDetail, { item, cwd: '/Users/example/project' })
    )
  )

  assert.doesNotMatch(markup, /目标文件/)
})

test('tool detail folds long inline output behind an explicit control', () => {
  const item: ToolCallItem = {
    id: 'tool-1',
    role: 'tool',
    toolName: 'shell',
    argsPreview: 'npm test',
    output: `${'a'.repeat(INLINE_OUTPUT_PREVIEW_CHARS + 50)}TAIL_SHOULD_NOT_RENDER_BY_DEFAULT`,
    outputBytes: INLINE_OUTPUT_PREVIEW_CHARS + 80,
    status: 'done'
  }
  const markup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, createElement(ToolCallDetail, { item }))
  )

  assert.match(markup, /输出 · 12 KB · 已折叠/)
  assert.match(markup, /显示完整输出/)
  assert.match(markup, /预览已截断/)
  assert.doesNotMatch(markup, /TAIL_SHOULD_NOT_RENDER_BY_DEFAULT/)
})

test('tool detail folds long args behind an explicit control', () => {
  const item: ToolCallItem = {
    id: 'tool-1',
    role: 'tool',
    toolName: 'shell',
    argsPreview: 'large args',
    argsJson: `${'a'.repeat(TOOL_ARGS_PREVIEW_CHARS + 20)}ARGS_TAIL_SHOULD_NOT_RENDER_BY_DEFAULT`,
    output: '',
    status: 'done'
  }
  const markup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, createElement(ToolCallDetail, { item }))
  )

  assert.match(markup, /参数 · 已折叠/)
  assert.match(markup, /显示完整参数/)
  assert.match(markup, /预览已截断/)
  assert.doesNotMatch(markup, /ARGS_TAIL_SHOULD_NOT_RENDER_BY_DEFAULT/)
})

test('tool detail renders local paths in plain output as reveal buttons', () => {
  const item: ToolCallItem = {
    id: 'tool-1',
    role: 'tool',
    toolName: 'shell',
    argsPreview: 'ls',
    argsJson: '',
    output: 'changed ./src/App.tsx and /Users/example/project/README.md.',
    status: 'done'
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ToolCallDetail, { item, cwd: '/Users/example/project' })
    )
  )

  assert.match(markup, /title="\/Users\/example\/project\/src\/App.tsx"/)
  assert.match(markup, /title="\/Users\/example\/project\/README.md"/)
  assert.match(markup, /<span>\.<\/span>/)
})

test('tool detail leaves diff output as plain colored lines', () => {
  const item: ToolCallItem = {
    id: 'tool-1',
    role: 'tool',
    toolName: 'shell',
    argsPreview: 'git diff',
    argsJson: '',
    output: '+ ./src/App.tsx',
    status: 'done'
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ToolCallDetail, { item, cwd: '/Users/example/project' })
    )
  )

  assert.doesNotMatch(markup, /title="\/Users\/example\/project\/src\/App.tsx"/)
  assert.match(markup, /\+ \.\/src\/App.tsx/)
})
