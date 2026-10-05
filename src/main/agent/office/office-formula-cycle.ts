export interface OfficeFormulaLocation {
  sheet: string
  cell: string
  formula: string
}

export interface OfficeFormulaReadResult {
  formula?: string
}

export type OfficeFormulaCycleResult =
  'circular_reference' | 'reference_graph_too_large' | undefined

export type OfficeFormulaReader = (
  target: Pick<OfficeFormulaLocation, 'sheet' | 'cell'>
) => Promise<OfficeFormulaReadResult | undefined>

interface FormulaReference {
  sheet: string
  cell: string
}

interface TraversalState {
  completed: Set<string>
  visiting: Set<string>
  reads: number
}

const MAX_VISITED_CELLS = 2_000
const MAX_RECURSION_DEPTH = 64
const MAX_COLUMN = 16_384
const MAX_ROW = 1_048_576
const REFERENCE_PATTERN =
  /(?<![A-Za-z0-9_.\u0080-\uFFFF])(?:('(?:[^']|'')+'|[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_.\u0080-\uFFFF]*)!)?(\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6})(?::(\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}))?(?![A-Za-z0-9_(])/gu

function normalizeCell(cell: string): string {
  return cell.replaceAll('$', '').toUpperCase()
}

function referenceKey(reference: FormulaReference): string {
  return `${reference.sheet.toLowerCase()}\u0000${reference.cell}`
}

function columnNumber(letters: string): number {
  let result = 0
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64
  return result
}

function validCell(cell: string): boolean {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/u.exec(cell)
  return Boolean(match && columnNumber(match[1]) <= MAX_COLUMN && Number(match[2]) <= MAX_ROW)
}

function decodeSheetName(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback
  return raw.startsWith("'") ? raw.slice(1, -1).replaceAll("''", "'") : raw
}

function cellCoordinates(cell: string): { column: number; row: number } {
  const match = /^([A-Z]+)(\d+)$/u.exec(cell)
  return { column: columnNumber(match?.[1] ?? ''), row: Number(match?.[2]) }
}

function columnLetters(column: number): string {
  let current = column
  let result = ''
  while (current > 0) {
    current -= 1
    result = String.fromCharCode(65 + (current % 26)) + result
    current = Math.floor(current / 26)
  }
  return result
}

function appendRange(
  references: FormulaReference[],
  sheet: string,
  firstCell: string,
  lastCell: string
): void {
  const first = cellCoordinates(firstCell)
  const last = cellCoordinates(lastCell)
  const rows = [Math.min(first.row, last.row), Math.max(first.row, last.row)]
  const columns = [Math.min(first.column, last.column), Math.max(first.column, last.column)]
  for (let row = rows[0]; row <= rows[1]; row += 1) {
    for (let column = columns[0]; column <= columns[1]; column += 1) {
      references.push({ sheet, cell: `${columnLetters(column)}${row}` })
      if (references.length > MAX_VISITED_CELLS) return
    }
  }
}

function withoutStringLiterals(formula: string): string {
  const characters = [...formula]
  let inside = false
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] !== '"') {
      if (inside) characters[index] = ' '
      continue
    }
    characters[index] = ' '
    if (inside && characters[index + 1] === '"') {
      characters[index + 1] = ' '
      index += 1
    } else {
      inside = !inside
    }
  }
  return characters.join('')
}

function extractReferences(formula: string, sheet: string): FormulaReference[] {
  const references: FormulaReference[] = []
  for (const match of withoutStringLiterals(formula).matchAll(REFERENCE_PATTERN)) {
    const firstCell = normalizeCell(match[2])
    const lastCell = match[3] ? normalizeCell(match[3]) : firstCell
    if (!validCell(firstCell) || !validCell(lastCell)) continue
    appendRange(references, decodeSheetName(match[1], sheet), firstCell, lastCell)
    if (references.length > MAX_VISITED_CELLS) return references
  }
  return references
}

async function visitReference(
  reference: FormulaReference,
  readCellFormula: OfficeFormulaReader,
  state: TraversalState,
  depth: number
): Promise<OfficeFormulaCycleResult> {
  const key = referenceKey(reference)
  if (state.visiting.has(key)) return 'circular_reference'
  if (state.completed.has(key)) return undefined
  if (depth > MAX_RECURSION_DEPTH || state.reads >= MAX_VISITED_CELLS) {
    return 'reference_graph_too_large'
  }
  state.reads += 1
  state.visiting.add(key)
  const current = await readCellFormula(reference)
  for (const dependency of extractReferences(current?.formula ?? '', reference.sheet)) {
    const result = await visitReference(dependency, readCellFormula, state, depth + 1)
    if (result) return result
  }
  state.visiting.delete(key)
  state.completed.add(key)
  return undefined
}

export async function detectOfficeFormulaCycle(
  input: OfficeFormulaLocation,
  readCellFormula: OfficeFormulaReader
): Promise<OfficeFormulaCycleResult> {
  const target = { sheet: input.sheet, cell: normalizeCell(input.cell) }
  const state: TraversalState = {
    completed: new Set<string>(),
    visiting: new Set<string>([referenceKey(target)]),
    reads: 0
  }
  for (const reference of extractReferences(input.formula, input.sheet)) {
    const result = await visitReference(reference, readCellFormula, state, 1)
    if (result) return result
  }
  return undefined
}
