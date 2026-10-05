const CELL_VALUE_SCHEMA = {
  oneOf: [{ type: 'string', maxLength: 32_767 }, { type: 'number' }, { type: 'boolean' }]
} as const

const RANGE_CELL_VALUE_SCHEMA = {
  oneOf: [
    { type: 'string', minLength: 1, maxLength: 32_767 },
    { type: 'number' },
    { type: 'boolean' }
  ]
} as const

const SET_CELL_OPERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'sheet', 'cell', 'value'],
  properties: {
    type: { const: 'set_cell' },
    sheet: {
      type: 'string',
      minLength: 1,
      maxLength: 31,
      pattern: '^[^\\\\/?*\\[\\]:\\u0000-\\u001F\\u007F]+$'
    },
    cell: {
      type: 'string',
      minLength: 2,
      maxLength: 10,
      pattern: '^[A-Za-z]{1,3}[1-9]\\d*$'
    },
    value: CELL_VALUE_SCHEMA
  }
} as const

const SET_RANGE_OPERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'sheet', 'range', 'values'],
  properties: {
    type: { const: 'set_range' },
    sheet: SET_CELL_OPERATION_SCHEMA.properties.sheet,
    range: {
      type: 'string',
      minLength: 5,
      maxLength: 21,
      pattern: '^[A-Za-z]{1,3}[1-9]\\d*:[A-Za-z]{1,3}[1-9]\\d*$'
    },
    values: {
      type: 'array',
      minItems: 1,
      maxItems: 1_000,
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: RANGE_CELL_VALUE_SCHEMA
      }
    }
  }
} as const

const SET_FORMULA_OPERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'sheet', 'cell', 'formula'],
  properties: {
    type: { const: 'set_formula' },
    sheet: SET_CELL_OPERATION_SCHEMA.properties.sheet,
    cell: SET_CELL_OPERATION_SCHEMA.properties.cell,
    formula: {
      type: 'string',
      minLength: 2,
      maxLength: 8_192,
      pattern: '^=[^\\u0000-\\u001F\\u007F-\\u009F]{1,8191}$'
    }
  }
} as const

const FORMAT_RANGE_OPERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'sheet', 'range', 'format'],
  properties: {
    type: { const: 'format_range' },
    sheet: SET_CELL_OPERATION_SCHEMA.properties.sheet,
    range: {
      type: 'string',
      minLength: 2,
      maxLength: 21,
      pattern: '^[A-Za-z]{1,3}[1-9]\\d*(?::[A-Za-z]{1,3}[1-9]\\d*)?$'
    },
    format: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        bold: { type: 'boolean' },
        fill: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
        horizontalAlign: { enum: ['left', 'center', 'right'] },
        numberFormat: { enum: ['General', '0', '0.00', '#,##0', '#,##0.00'] }
      }
    }
  }
} as const

const ADD_SHEET_OPERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'name'],
  properties: {
    type: { const: 'add_sheet' },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 31,
      pattern: "^(?!\\s)(?!.*\\s$)(?!')(?!.*'$)[^\\\\/?*\\[\\]:\\u0000-\\u001F\\u007F-\\u009F]+$"
    }
  }
} as const

const PARAGRAPH_TEXT_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: OFFICE_DOCUMENT_LIMITS.maxParagraphTextLength,
  pattern: '^[^\\u0000-\\u0008\\u000A-\\u001F\\u007F-\\u009F]+$'
} as const

const PARA_ID_SCHEMA = {
  type: 'string',
  pattern: '^[0-9A-Fa-f]{8}$'
} as const

const ADD_PARAGRAPH_OPERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'text'],
  properties: {
    type: { const: 'add_paragraph' },
    text: PARAGRAPH_TEXT_SCHEMA,
    position: {
      oneOf: [
        { const: 'end' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['after'],
          properties: { after: PARA_ID_SCHEMA }
        }
      ]
    }
  }
} as const

const SET_PARAGRAPH_TEXT_OPERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'paraId', 'text'],
  properties: {
    type: { const: 'set_paragraph_text' },
    paraId: PARA_ID_SCHEMA,
    text: PARAGRAPH_TEXT_SCHEMA,
    expectedText: {
      type: 'string',
      maxLength: OFFICE_DOCUMENT_LIMITS.maxParagraphTextLength,
      pattern: '^[^\\u0000-\\u0008\\u000A-\\u001F\\u007F-\\u009F]*$'
    }
  }
} as const

const SLIDE_ID_SCHEMA = { type: 'string', pattern: '^\\d{1,10}$' } as const
const ELEMENT_ID_SCHEMA = { type: 'string', pattern: '^\\d{1,10}$' } as const
const SLIDE_TEXT_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: OFFICE_PRESENTATION_LIMITS.maxBodyTextLength,
  pattern: '^[^\\u0000-\\u0008\\u000A-\\u001F\\u007F-\\u009F]+$'
} as const

const ADD_SLIDE_OPERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title'],
  properties: {
    type: { const: 'add_slide' },
    title: { ...SLIDE_TEXT_SCHEMA, maxLength: OFFICE_PRESENTATION_LIMITS.maxTitleTextLength },
    body: { ...SLIDE_TEXT_SCHEMA, minLength: 0 },
    position: {
      oneOf: [
        { const: 'end' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['after'],
          properties: { after: SLIDE_ID_SCHEMA }
        }
      ]
    }
  }
} as const

const SET_SLIDE_TEXT_OPERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'slideId', 'elementId', 'text'],
  properties: {
    type: { const: 'set_slide_text' },
    slideId: SLIDE_ID_SCHEMA,
    elementId: ELEMENT_ID_SCHEMA,
    text: SLIDE_TEXT_SCHEMA,
    expectedText: { ...SLIDE_TEXT_SCHEMA, minLength: 0 }
  }
} as const

export const OFFICE_APPLY_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['operation', 'baseRevision'],
  properties: {
    operation: {
      oneOf: [
        SET_CELL_OPERATION_SCHEMA,
        SET_RANGE_OPERATION_SCHEMA,
        SET_FORMULA_OPERATION_SCHEMA,
        FORMAT_RANGE_OPERATION_SCHEMA,
        ADD_SHEET_OPERATION_SCHEMA,
        ADD_PARAGRAPH_OPERATION_SCHEMA,
        SET_PARAGRAPH_TEXT_OPERATION_SCHEMA,
        ADD_SLIDE_OPERATION_SCHEMA,
        SET_SLIDE_TEXT_OPERATION_SCHEMA
      ]
    },
    baseRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
  }
} as const

export const OFFICE_APPLY_DESCRIPTION =
  '修改当前运行关联的 XLSX、DOCX 或 PPTX。必须先用 office_read 取得最新 revision；不同文档类型的操作不能混用。PowerPoint 新增单页用 add_slide（标题必填，正文可选，最多 200 页）；修改普通标题/正文文本用 set_slide_text，必须使用读取返回的稳定 slideId、elementId，并建议携带 expectedText。PPTX 不支持图片、表格、图表、动画、母版、删除页、批量或布局调整。Word 用 add_paragraph/set_paragraph_text 且按 paraId 定位。Excel 支持 set_cell、set_range、set_formula、format_range、add_sheet：set_formula 的 formula 必须以 = 开头，成功回执含 computedValue；SUM、AVERAGE、IF、VLOOKUP、XLOOKUP 等常用公式可用，含空格的工作表名需用单引号引用，无法可靠计算会返回 formula_invalid；字面文本以 = 开头当前不支持。format_range 只修改格式，不改变数据。add_sheet 最多 20 张工作表，同名会被拒绝；成功后用返回的 sheet 名继续 office_read。写入后使用返回的新 revision 继续操作。'

export function normalizeOfficeApplyParams(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.operation)) return {}
  const operation = value.operation
  return {
    operation: normalizedOperation(operation),
    baseRevision: value.baseRevision
  }
}

function normalizedOperation(operation: Record<string, unknown>): Record<string, unknown> {
  if (
    operation.type === 'add_slide' ||
    operation.type === 'set_slide_text' ||
    operation.type === 'add_paragraph' ||
    operation.type === 'set_paragraph_text'
  ) {
    return normalizedDocumentOperation(operation)
  }
  return normalizedWorkbookOperation(operation)
}

function normalizedDocumentOperation(operation: Record<string, unknown>): Record<string, unknown> {
  if (operation.type === 'add_slide') {
    return {
      type: operation.type,
      title: operation.title,
      body: operation.body,
      position: operation.position
    }
  }
  if (operation.type === 'set_slide_text') {
    return {
      type: operation.type,
      slideId: operation.slideId,
      elementId: operation.elementId,
      text: operation.text,
      expectedText: operation.expectedText
    }
  }
  if (operation.type === 'add_paragraph') {
    return { type: operation.type, text: operation.text, position: operation.position }
  }
  return {
    type: operation.type,
    paraId: operation.paraId,
    text: operation.text,
    expectedText: operation.expectedText
  }
}

function normalizedWorkbookOperation(operation: Record<string, unknown>): Record<string, unknown> {
  if (operation.type === 'add_sheet') {
    return { type: operation.type, name: operation.name }
  }
  if (operation.type === 'format_range') {
    return {
      type: operation.type,
      sheet: operation.sheet,
      range: operation.range,
      format: operation.format
    }
  }
  if (operation.type === 'set_range') {
    return {
      type: operation.type,
      sheet: operation.sheet,
      range: operation.range,
      values: operation.values
    }
  }
  if (operation.type === 'set_formula') {
    return {
      type: operation.type,
      sheet: operation.sheet,
      cell: operation.cell,
      formula: operation.formula
    }
  }
  return {
    type: operation.type,
    sheet: operation.sheet,
    cell: operation.cell,
    value: operation.value
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
import { OFFICE_DOCUMENT_LIMITS, OFFICE_PRESENTATION_LIMITS } from './office-limits'
