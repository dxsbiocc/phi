export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonObject = { [key: string]: JsonValue }

export type NotebookCellType = 'code' | 'markdown' | 'raw'

export interface NotebookOutput {
  outputType: string
  data: JsonObject
  metadata: JsonObject
  name?: string
  text?: string
  executionCount?: number | null
  ename?: string
  evalue?: string
  traceback?: string[]
  extra: JsonObject
}

export interface NotebookCell {
  id: string
  cellType: NotebookCellType
  source: string
  metadata: JsonObject
  executionCount: number | null
  outputs: NotebookOutput[]
  extra: JsonObject
  contentHash: string
}

export interface NotebookDocument {
  nbformat: number
  nbformatMinor: number
  metadata: JsonObject
  cells: NotebookCell[]
  extra: JsonObject
  revision: string
}

export interface NotebookCellInput {
  id?: string
  cellType: NotebookCellType
  source?: string
  metadata?: JsonObject
  executionCount?: number | null
  outputs?: NotebookOutput[]
  extra?: JsonObject
}

type RawNotebookCell = JsonObject & {
  id?: JsonValue
  cell_type?: JsonValue
  source?: JsonValue
  metadata?: JsonValue
  execution_count?: JsonValue
  outputs?: JsonValue
}

const NOTEBOOK_KEYS = new Set(['nbformat', 'nbformat_minor', 'metadata', 'cells'])
const CELL_KEYS = new Set(['id', 'cell_type', 'source', 'metadata', 'execution_count', 'outputs'])
const OUTPUT_KEYS = new Set([
  'output_type',
  'data',
  'metadata',
  'name',
  'text',
  'execution_count',
  'ename',
  'evalue',
  'traceback'
])

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nullableNumberValue(value: JsonValue | undefined): number | null {
  if (value === null || value === undefined) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringArrayValue(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length === value.length ? strings : undefined
}

function cloneJsonObject(input: JsonObject | undefined): JsonObject {
  return input ? (structuredClone(input) as JsonObject) : {}
}

function pickExtra(input: JsonObject, knownKeys: Set<string>): JsonObject {
  const extra: JsonObject = {}
  for (const [key, value] of Object.entries(input)) {
    if (!knownKeys.has(key)) {
      extra[key] = value
    }
  }
  return extra
}

function normalizeSource(source: JsonValue | undefined): string {
  if (typeof source === 'string') return source
  if (Array.isArray(source)) {
    return source.map((item) => (typeof item === 'string' ? item : '')).join('')
  }
  return ''
}

function serializeSource(source: string): string[] {
  if (source.length === 0) return []
  const lines = source.match(/[^\n]*\n|[^\n]+/g)
  return lines ?? []
}

function normalizeCellType(value: JsonValue | undefined): NotebookCellType {
  if (value === 'code' || value === 'markdown' || value === 'raw') return value
  return 'code'
}

function normalizeCellId(rawId: JsonValue | undefined, index: number, seen: Set<string>): string {
  const candidate = typeof rawId === 'string' && rawId.trim() ? rawId : `phi-cell-${index + 1}`
  if (!seen.has(candidate)) {
    seen.add(candidate)
    return candidate
  }

  let suffix = 2
  while (seen.has(`${candidate}-${suffix}`)) {
    suffix += 1
  }
  const next = `${candidate}-${suffix}`
  seen.add(next)
  return next
}

function normalizeOutput(input: JsonValue): NotebookOutput {
  const raw = isJsonObject(input) ? input : {}
  const traceback = stringArrayValue(raw.traceback)
  const output: NotebookOutput = {
    outputType: stringValue(raw.output_type) ?? 'unknown',
    data: isJsonObject(raw.data) ? cloneJsonObject(raw.data) : {},
    metadata: isJsonObject(raw.metadata) ? cloneJsonObject(raw.metadata) : {},
    extra: pickExtra(raw, OUTPUT_KEYS)
  }
  const name = stringValue(raw.name)
  const text = normalizeSource(raw.text)
  const executionCount = nullableNumberValue(raw.execution_count)
  const ename = stringValue(raw.ename)
  const evalue = stringValue(raw.evalue)

  if (name !== undefined) output.name = name
  if (text.length > 0 || raw.text !== undefined) output.text = text
  if (raw.execution_count !== undefined) output.executionCount = executionCount
  if (ename !== undefined) output.ename = ename
  if (evalue !== undefined) output.evalue = evalue
  if (traceback !== undefined) output.traceback = traceback
  return output
}

function serializeOutput(output: NotebookOutput): JsonObject {
  const raw: JsonObject = {
    ...cloneJsonObject(output.extra),
    output_type: output.outputType
  }
  if (
    Object.keys(output.data).length > 0 ||
    output.outputType === 'display_data' ||
    output.outputType === 'execute_result' ||
    output.outputType === 'update_display_data'
  ) {
    raw.data = cloneJsonObject(output.data)
  }
  if (Object.keys(output.metadata).length > 0 || raw.data !== undefined) {
    raw.metadata = cloneJsonObject(output.metadata)
  }
  if (output.name !== undefined) raw.name = output.name
  if (output.text !== undefined) raw.text = serializeSource(output.text)
  if (output.executionCount !== undefined) raw.execution_count = output.executionCount
  if (output.ename !== undefined) raw.ename = output.ename
  if (output.evalue !== undefined) raw.evalue = output.evalue
  if (output.traceback !== undefined) raw.traceback = [...output.traceback]
  return raw
}

function cloneNotebookOutput(output: NotebookOutput): NotebookOutput {
  return {
    ...output,
    data: cloneJsonObject(output.data),
    metadata: cloneJsonObject(output.metadata),
    traceback: output.traceback ? [...output.traceback] : undefined,
    extra: cloneJsonObject(output.extra)
  }
}

function createCell(input: NotebookCellInput, index: number, seen: Set<string>): NotebookCell {
  const cell: Omit<NotebookCell, 'contentHash'> = {
    id: normalizeCellId(input.id, index, seen),
    cellType: input.cellType,
    source: input.source ?? '',
    metadata: cloneJsonObject(input.metadata),
    executionCount: input.cellType === 'code' ? (input.executionCount ?? null) : null,
    outputs: input.cellType === 'code' ? (input.outputs?.map(cloneNotebookOutput) ?? []) : [],
    extra: cloneJsonObject(input.extra)
  }
  return { ...cell, contentHash: hashNotebookValue(cell) }
}

function normalizeCell(input: JsonValue, index: number, seen: Set<string>): NotebookCell {
  const raw: RawNotebookCell = isJsonObject(input) ? input : {}
  const cellType = normalizeCellType(raw.cell_type)
  return createCell(
    {
      id: stringValue(raw.id),
      cellType,
      source: normalizeSource(raw.source),
      metadata: isJsonObject(raw.metadata) ? raw.metadata : {},
      executionCount: cellType === 'code' ? nullableNumberValue(raw.execution_count) : null,
      outputs:
        cellType === 'code' && Array.isArray(raw.outputs) ? raw.outputs.map(normalizeOutput) : [],
      extra: pickExtra(raw, CELL_KEYS)
    },
    index,
    seen
  )
}

function serializeCell(cell: NotebookCell): JsonObject {
  const raw: JsonObject = {
    ...cloneJsonObject(cell.extra),
    id: cell.id,
    cell_type: cell.cellType,
    metadata: cloneJsonObject(cell.metadata),
    source: serializeSource(cell.source)
  }
  if (cell.cellType === 'code') {
    raw.execution_count = cell.executionCount
    raw.outputs = cell.outputs.map(serializeOutput)
  }
  return raw
}

function withRevision(input: Omit<NotebookDocument, 'revision'>): NotebookDocument {
  const document = {
    ...input,
    cells: input.cells.map((cell) => ({ ...cell, contentHash: cellContentHash(cell) }))
  }
  return { ...document, revision: hashNotebookValue(serializeNotebookBody(document)) }
}

function serializeNotebookBody(document: Omit<NotebookDocument, 'revision'>): JsonObject {
  return {
    ...cloneJsonObject(document.extra),
    nbformat: document.nbformat,
    nbformat_minor: document.nbformatMinor,
    metadata: cloneJsonObject(document.metadata),
    cells: document.cells.map(serializeCell)
  }
}

export function parseNotebook(input: unknown): NotebookDocument {
  if (!isJsonObject(input)) {
    throw new Error('Notebook must be a JSON object')
  }
  const cellsRaw = input.cells
  if (!Array.isArray(cellsRaw)) {
    throw new Error('Notebook cells must be an array')
  }
  const seen = new Set<string>()
  return withRevision({
    nbformat: numberValue(input.nbformat) ?? 4,
    nbformatMinor: numberValue(input.nbformat_minor) ?? 5,
    metadata: isJsonObject(input.metadata) ? cloneJsonObject(input.metadata) : {},
    cells: cellsRaw.map((cell, index) => normalizeCell(cell, index, seen)),
    extra: pickExtra(input, NOTEBOOK_KEYS)
  })
}

export function serializeNotebook(document: NotebookDocument): JsonObject {
  return serializeNotebookBody(document)
}

export function updateNotebookMetadata(
  document: NotebookDocument,
  metadata: JsonObject
): NotebookDocument {
  return withRevision({ ...document, metadata: cloneJsonObject(metadata) })
}

export function createNotebookCell(
  input: NotebookCellInput,
  existingIds: Iterable<string> = []
): NotebookCell {
  return createCell(input, 0, new Set(existingIds))
}

export function insertNotebookCell(
  document: NotebookDocument,
  index: number,
  input: NotebookCellInput
): NotebookDocument {
  const nextCells = [...document.cells]
  const boundedIndex = Math.max(0, Math.min(index, nextCells.length))
  nextCells.splice(
    boundedIndex,
    0,
    createNotebookCell(
      input,
      nextCells.map((cell) => cell.id)
    )
  )
  return withRevision({ ...document, cells: nextCells })
}

export function updateNotebookCell(
  document: NotebookDocument,
  cellId: string,
  patch: Partial<
    Pick<NotebookCell, 'source' | 'metadata' | 'cellType' | 'executionCount' | 'outputs'>
  >
): NotebookDocument {
  let changed = false
  const cells = document.cells.map((cell) => {
    if (cell.id !== cellId) return cell
    changed = true
    const cellType = patch.cellType ?? cell.cellType
    const nextCell: Omit<NotebookCell, 'contentHash'> = {
      ...cell,
      cellType,
      source: patch.source ?? cell.source,
      metadata: patch.metadata ? cloneJsonObject(patch.metadata) : cell.metadata,
      executionCount:
        cellType === 'code'
          ? 'executionCount' in patch
            ? (patch.executionCount ?? null)
            : cell.executionCount
          : null,
      outputs: cellType === 'code' ? (patch.outputs ?? cell.outputs).map(cloneNotebookOutput) : []
    }
    return { ...nextCell, contentHash: hashNotebookValue(nextCell) }
  })
  if (!changed) {
    throw new Error(`Notebook cell not found: ${cellId}`)
  }
  return withRevision({ ...document, cells })
}

export function moveNotebookCell(
  document: NotebookDocument,
  cellId: string,
  targetIndex: number
): NotebookDocument {
  const fromIndex = document.cells.findIndex((cell) => cell.id === cellId)
  if (fromIndex < 0) {
    throw new Error(`Notebook cell not found: ${cellId}`)
  }
  const cells = [...document.cells]
  const [cell] = cells.splice(fromIndex, 1)
  const boundedIndex = Math.max(0, Math.min(targetIndex, cells.length))
  cells.splice(boundedIndex, 0, cell)
  return withRevision({ ...document, cells })
}

export function deleteNotebookCell(document: NotebookDocument, cellId: string): NotebookDocument {
  const cells = document.cells.filter((cell) => cell.id !== cellId)
  if (cells.length === document.cells.length) {
    throw new Error(`Notebook cell not found: ${cellId}`)
  }
  return withRevision({ ...document, cells })
}

export function clearNotebookCellOutput(
  document: NotebookDocument,
  cellId: string
): NotebookDocument {
  return updateNotebookCell(document, cellId, { executionCount: null, outputs: [] })
}

export function cellContentHash(cell: NotebookCell): string {
  return hashNotebookValue({
    cell_type: cell.cellType,
    source: cell.source,
    metadata: cell.metadata,
    execution_count: cell.executionCount,
    outputs: cell.outputs,
    extra: cell.extra
  })
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '"__undefined__"'
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function hashNotebookValue(value: unknown): string {
  const text = stableStringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `nb-${(hash >>> 0).toString(16).padStart(8, '0')}`
}
