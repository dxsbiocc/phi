import { z } from 'zod'

export const MAX_UI_BLOCKS = 6
export const MAX_UI_TABLE_ROWS = 200
export const MAX_UI_TABLE_COLUMNS = 12
export const MAX_UI_TEXT_LENGTH = 200
export const MAX_UI_METRICS = 24
export const MAX_UI_STEPS = 50

const textSchema = z.string().max(MAX_UI_TEXT_LENGTH)
const requiredTextSchema = z.string().min(1).max(MAX_UI_TEXT_LENGTH)
const finiteNumberSchema = z.number().finite()

const metricItemSchema = z
  .object({
    label: requiredTextSchema,
    value: z.union([textSchema, finiteNumberSchema]),
    unit: textSchema.optional(),
    status: z.enum(['ok', 'warn', 'error', 'neutral']).optional(),
    hint: textSchema.optional()
  })
  .strict()

const metricsBlockSchema = z
  .object({
    type: z.literal('metrics'),
    title: textSchema.optional(),
    items: z.array(metricItemSchema).min(1).max(MAX_UI_METRICS)
  })
  .strict()

const tableCellSchema = z.union([textSchema, finiteNumberSchema, z.null()])
const tableColumnKeySchema = z.string().min(1).max(64)

const tableBlockSchema = z
  .object({
    type: z.literal('table'),
    title: textSchema.optional(),
    columns: z
      .array(
        z
          .object({
            key: tableColumnKeySchema,
            label: requiredTextSchema,
            align: z.enum(['left', 'center', 'right']).optional()
          })
          .strict()
      )
      .min(1)
      .max(MAX_UI_TABLE_COLUMNS),
    rows: z.array(z.record(z.string(), tableCellSchema)).max(MAX_UI_TABLE_ROWS)
  })
  .strict()
  .superRefine((block, context) => {
    const keys = new Set(block.columns.map((column) => column.key))
    if (keys.size !== block.columns.length) {
      context.addIssue({ code: 'custom', path: ['columns'], message: 'Column keys must be unique' })
    }
    block.rows.forEach((row, rowIndex) => {
      Object.keys(row).forEach((key) => {
        if (!keys.has(key) || key.length > 64) {
          context.addIssue({
            code: 'custom',
            path: ['rows', rowIndex, key],
            message: 'Rows may contain only declared column keys'
          })
        }
      })
    })
  })

const stepItemSchema = z
  .object({
    label: requiredTextSchema,
    status: z.enum(['done', 'running', 'pending', 'failed']),
    detail: textSchema.optional()
  })
  .strict()

const stepsBlockSchema = z
  .object({
    type: z.literal('steps'),
    title: textSchema.optional(),
    items: z.array(stepItemSchema).min(1).max(MAX_UI_STEPS)
  })
  .strict()

export const uiBlockSchema = z.discriminatedUnion('type', [
  tableBlockSchema,
  metricsBlockSchema,
  stepsBlockSchema
])

export const uiBlocksSchema = z.array(uiBlockSchema).min(1).max(MAX_UI_BLOCKS)
export const renderBlocksInputSchema = z.object({ blocks: uiBlocksSchema }).strict()
export const uiBlocksDetailsSchema = z
  .object({ kind: z.literal('ui_blocks'), blocks: uiBlocksSchema })
  .strict()

export type UiBlock = z.infer<typeof uiBlockSchema>
export type UiBlocks = z.infer<typeof uiBlocksSchema>
export type RenderBlocksInput = z.infer<typeof renderBlocksInputSchema>
export type UiBlocksDetails = z.infer<typeof uiBlocksDetailsSchema>
export type TableUiBlock = Extract<UiBlock, { type: 'table' }>
export type MetricsUiBlock = Extract<UiBlock, { type: 'metrics' }>
export type StepsUiBlock = Extract<UiBlock, { type: 'steps' }>
