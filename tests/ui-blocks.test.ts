import assert from 'node:assert/strict'
import test from 'node:test'

import { CORE_TOOLS } from '../src/main/agent/core-tools'
import { buildRenderBlocksTool } from '../src/main/agent/deliverables/render-blocks-tool'
import { toolResultDetailsForSession } from '../src/main/agent/session/session-store'
import {
  sortTableRows,
  uiBlocksItemFromToolEvent
} from '../src/renderer/src/features/chat/lib/uiBlocks'
import { uiBlocksSchema } from '../src/shared/uiBlockTypes'

test('ui block schema accepts a valid metrics block', () => {
  const blocks = [
    {
      type: 'metrics',
      title: '质控摘要',
      items: [{ label: '有效读取', value: 98.4, unit: '%', status: 'ok', hint: '目标 ≥ 95%' }]
    }
  ]

  assert.deepEqual(uiBlocksSchema.parse(blocks), blocks)
})

test('ui block schema accepts valid table and steps blocks', () => {
  const blocks = [
    {
      type: 'table',
      title: '差异表达',
      columns: [
        { key: 'gene', label: '基因' },
        { key: 'log2fc', label: 'log2FC', align: 'right' }
      ],
      rows: [
        { gene: 'TP53', log2fc: 2.1 },
        { gene: 'EGFR', log2fc: null }
      ]
    },
    {
      type: 'steps',
      title: '分析进度',
      items: [
        { label: '质量控制', status: 'done' },
        { label: '差异分析', status: 'running', detail: '正在拟合模型' }
      ]
    }
  ]

  assert.deepEqual(uiBlocksSchema.parse(blocks), blocks)
})

test('ui block schema rejects unknown block types', () => {
  const result = uiBlocksSchema.safeParse([{ type: 'chart', series: [] }])

  assert.equal(result.success, false)
})

test('ui block schema rejects extra keys instead of stripping them', () => {
  const result = uiBlocksSchema.safeParse([
    {
      type: 'metrics',
      items: [{ label: '样本数', value: 12, html: '<b>12</b>' }],
      layout: 'agent-controlled'
    }
  ])

  assert.equal(result.success, false)
})

test('ui block schema rejects tables over the row limit', () => {
  const result = uiBlocksSchema.safeParse([
    {
      type: 'table',
      columns: [{ key: 'sample', label: '样本' }],
      rows: Array.from({ length: 201 }, (_, index) => ({ sample: `S${index + 1}` }))
    }
  ])

  assert.equal(result.success, false)
})

test('ui block schema keeps HTML-like content as ordinary text', () => {
  const text = '<img src=x onerror="globalThis.pwned=true"> **not markdown**'
  const parsed = uiBlocksSchema.parse([
    {
      type: 'steps',
      items: [{ label: text, status: 'failed', detail: '<script>alert(1)</script>' }]
    }
  ])

  assert.equal(parsed[0].type, 'steps')
  assert.equal(parsed[0].items[0].label, text)
  assert.equal(parsed[0].items[0].detail, '<script>alert(1)</script>')
})

test('ui block schema rejects table cell text over 200 characters', () => {
  const result = uiBlocksSchema.safeParse([
    {
      type: 'table',
      columns: [{ key: 'note', label: '备注' }],
      rows: [{ note: 'x'.repeat(201) }]
    }
  ])

  assert.equal(result.success, false)
})

test('render_blocks returns validated blocks in ui_blocks details', async () => {
  const tool = buildRenderBlocksTool()
  const blocks = [
    {
      type: 'metrics' as const,
      items: [{ label: '样本数', value: 12, status: 'neutral' as const }]
    }
  ]

  const result = await tool.execute('call-1', { blocks })

  assert.equal(tool.name, 'render_blocks')
  assert.equal(tool.approval, 'read')
  assert.deepEqual(result.details, { kind: 'ui_blocks', blocks })
  assert.equal(result.isError, undefined)
})

test('render_blocks returns a tool error for invalid input', async () => {
  const tool = buildRenderBlocksTool()

  const result = await tool.execute('call-2', {
    blocks: [{ type: 'metrics', items: [{ label: '样本数', value: 12, script: 'alert(1)' }] }]
  })

  assert.equal(result.isError, true)
  assert.equal(result.details, undefined)
  assert.match(result.content[0].text ?? '', /请改用 Markdown/u)
})

test('renderer item builder returns null for invalid ui block details', () => {
  const item = uiBlocksItemFromToolEvent({
    type: 'tool_call_completed',
    toolCallId: 'call-invalid',
    details: {
      kind: 'ui_blocks',
      blocks: [{ type: 'table', columns: [], rows: [], layout: '<script>alert(1)</script>' }]
    }
  })

  assert.equal(item, null)
})

test('renderer item builder revalidates and copies valid ui block details', () => {
  const blocks = [{ type: 'steps' as const, items: [{ label: '归一化', status: 'done' as const }] }]
  const item = uiBlocksItemFromToolEvent({
    type: 'tool_execution_end',
    toolCallId: 'call-valid',
    runId: 'run-1',
    result: { details: { kind: 'ui_blocks', blocks } }
  })

  assert.deepEqual(item, {
    id: 'ui-blocks-call-valid',
    role: 'ui_blocks',
    runId: 'run-1',
    blocks
  })
  assert.notEqual(item?.blocks, blocks)
})

test('render_blocks is an engine-owned core tool', () => {
  assert.equal(CORE_TOOLS.has('render_blocks'), true)
})

test('session persistence retains only validated render_blocks details', () => {
  const details = {
    kind: 'ui_blocks',
    blocks: [{ type: 'metrics', items: [{ label: '样本数', value: 12 }] }]
  }

  assert.deepEqual(toolResultDetailsForSession('render_blocks', { details }), details)
  assert.equal(
    toolResultDetailsForSession('render_blocks', {
      details: { ...details, blocks: [{ type: 'iframe', src: 'https://example.org' }] }
    }),
    undefined
  )
  assert.equal(toolResultDetailsForSession('bash', { details }), undefined)
})

test('table sorting returns a sorted copy and keeps empty values last', () => {
  const rows = [{ score: 3 }, { score: null }, { score: 1 }]

  assert.deepEqual(sortTableRows(rows, 'score', 'asc'), [
    { score: 1 },
    { score: 3 },
    { score: null }
  ])
  assert.deepEqual(sortTableRows(rows, 'score', 'desc'), [
    { score: 3 },
    { score: 1 },
    { score: null }
  ])
  assert.deepEqual(rows, [{ score: 3 }, { score: null }, { score: 1 }])
})
