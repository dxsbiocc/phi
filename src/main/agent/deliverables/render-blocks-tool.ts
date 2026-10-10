import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import {
  MAX_UI_BLOCKS,
  MAX_UI_METRICS,
  MAX_UI_STEPS,
  MAX_UI_TABLE_COLUMNS,
  MAX_UI_TABLE_ROWS,
  MAX_UI_TEXT_LENGTH,
  renderBlocksInputSchema
} from '../../../shared/uiBlockTypes'

const textSchema = { type: 'string', maxLength: MAX_UI_TEXT_LENGTH } as const
const valueSchema = {
  anyOf: [textSchema, { type: 'number' }, { type: 'null' }]
} as const

export function buildRenderBlocksTool(): CustomTool {
  return {
    name: 'render_blocks',
    label: '结构化结果',
    description:
      'Show structured, read-only results inline in chat. Use only for tabular results, QC metrics, or progress that the user would otherwise read as a wall of text. Provide at most 6 blocks. You cannot define layout, HTML, scripts, or new component types. Otherwise write Markdown.',
    loadMode: 'essential',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['blocks'],
      properties: {
        blocks: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_UI_BLOCKS,
          items: {
            oneOf: [tableParameters(), metricsParameters(), stepsParameters()]
          }
        }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const parsed = renderBlocksInputSchema.safeParse(params)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        const reason = issue ? `${issue.path.join('.') || 'blocks'}：${issue.message}` : '未知错误'
        return {
          content: [
            { type: 'text', text: `render_blocks 输入无效（${reason}）。请改用 Markdown。` }
          ],
          isError: true
        }
      }
      return {
        content: [{ type: 'text', text: `已显示 ${parsed.data.blocks.length} 个结构化结果。` }],
        details: { kind: 'ui_blocks', blocks: parsed.data.blocks }
      }
    }
  }
}

function tableParameters(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'columns', 'rows'],
    properties: {
      type: { const: 'table' },
      title: textSchema,
      columns: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_UI_TABLE_COLUMNS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'label'],
          properties: {
            key: { type: 'string', minLength: 1, maxLength: 64 },
            label: { type: 'string', minLength: 1, maxLength: MAX_UI_TEXT_LENGTH },
            align: { enum: ['left', 'center', 'right'] }
          }
        }
      },
      rows: {
        type: 'array',
        maxItems: MAX_UI_TABLE_ROWS,
        items: {
          type: 'object',
          maxProperties: MAX_UI_TABLE_COLUMNS,
          additionalProperties: valueSchema
        }
      }
    }
  }
}

function metricsParameters(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'items'],
    properties: {
      type: { const: 'metrics' },
      title: textSchema,
      items: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_UI_METRICS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'value'],
          properties: {
            label: { type: 'string', minLength: 1, maxLength: MAX_UI_TEXT_LENGTH },
            value: { anyOf: [textSchema, { type: 'number' }] },
            unit: textSchema,
            status: { enum: ['ok', 'warn', 'error', 'neutral'] },
            hint: textSchema
          }
        }
      }
    }
  }
}

function stepsParameters(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'items'],
    properties: {
      type: { const: 'steps' },
      title: textSchema,
      items: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_UI_STEPS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'status'],
          properties: {
            label: { type: 'string', minLength: 1, maxLength: MAX_UI_TEXT_LENGTH },
            status: { enum: ['done', 'running', 'pending', 'failed'] },
            detail: textSchema
          }
        }
      }
    }
  }
}
