import type { NotebookDocument } from '../../../shared/notebookDocument'

export type AnalysisNotebookCodeGenerationInput = {
  prompt: string
  language: string
  afterCellId?: string | null
  references?: AnalysisNotebookContextReference[]
}

export type AnalysisNotebookContextReference = {
  id: string
  kind: 'dataframe' | 'data_source' | 'variable' | 'cell_output'
  name: string
  detail?: string
  cellId?: string
  preview?: {
    source?: string
    code?: string
    output?: string
    value?: string
    shape?: string
    columns?: Array<{ name: string; type?: string }>
  }
}

export type AnalysisNotebookGeneratedCell = {
  cellType: 'code' | 'markdown'
  source: string
  language?: string
}

export type NotebookPromptContext = {
  insertionIndex: number
  nearbyContext: string
  otherCellContext: string
}

const markdownLanguages = new Set(['markdown', 'md'])

export function truncateNotebookPromptText(value: string, maxLength = 1200): string {
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, maxLength).trimEnd()}\n...`
}

export function notebookCellPromptContext(
  document: NotebookDocument,
  afterCellId: string | null | undefined
): NotebookPromptContext {
  const afterIndex = afterCellId
    ? document.cells.findIndex((cell) => cell.id === afterCellId)
    : document.cells.length - 1
  const insertionIndex = afterIndex >= 0 ? afterIndex + 1 : document.cells.length
  const contextStart = Math.max(0, insertionIndex - 3)
  const contextEnd = Math.min(document.cells.length, insertionIndex + 2)
  const nearbyContext = document.cells
    .slice(contextStart, contextEnd)
    .map((cell, offset) => {
      const index = contextStart + offset
      const marker = index === afterIndex ? ' <- insert after this cell' : ''
      return [
        `Cell ${index + 1} [${cell.cellType}]${marker}`,
        '```',
        truncateNotebookPromptText(cell.source) || '(empty)',
        '```'
      ].join('\n')
    })
    .join('\n\n')

  const otherCellContext = document.cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ index }) => index < contextStart || index >= contextEnd)
    .slice(-20)
    .map(({ cell, index }) => {
      return [
        `Cell ${index + 1} [${cell.cellType}]`,
        '```',
        truncateNotebookPromptText(cell.source, 700) || '(empty)',
        '```'
      ].join('\n')
    })
    .join('\n\n')

  return {
    insertionIndex,
    nearbyContext: nearbyContext || '(notebook is empty)',
    otherCellContext: otherCellContext || '(none)'
  }
}

export function notebookContextReferencePrompt(
  references: AnalysisNotebookContextReference[] | undefined
): string {
  if (!references?.length) return '(none)'
  return references
    .map((reference) => {
      const token = `@${reference.kind}://${reference.name}`
      const lines = [
        `- ${token}`,
        `  name: ${reference.name}`,
        `  kind: ${reference.kind}`,
        reference.detail ? `  detail: ${reference.detail}` : null,
        reference.cellId ? `  cellId: ${reference.cellId}` : null,
        reference.preview?.shape ? `  shape: ${reference.preview.shape}` : null,
        reference.preview?.columns?.length
          ? `  columns: ${reference.preview.columns
              .slice(0, 30)
              .map((column) => `${column.name}${column.type ? ` (${column.type})` : ''}`)
              .join(', ')}`
          : null,
        reference.preview?.source
          ? `  source: ${truncateNotebookPromptText(reference.preview.source, 500)}`
          : null,
        reference.preview?.code
          ? `  code:\n${indentBlock(truncateNotebookPromptText(reference.preview.code, 900), 4)}`
          : null,
        reference.preview?.output
          ? `  output:\n${indentBlock(truncateNotebookPromptText(reference.preview.output, 900), 4)}`
          : null,
        reference.preview?.value
          ? `  value: ${truncateNotebookPromptText(reference.preview.value, 500)}`
          : null
      ].filter((line): line is string => Boolean(line))
      return lines.join('\n')
    })
    .join('\n')
}

export function buildNotebookCodeGenerationPrompt(input: {
  language: string
  notebookPath: string
  insertionIndex: number
  references?: AnalysisNotebookContextReference[]
  userPrompt: string
  nearbyContext: string
  otherCellContext: string
}): string {
  const language = normalizeLanguage(input.language)
  return [
    'You are Phi Notebook AI, an assistant integrated into a Jupyter-compatible notebook editor.',
    'Use the marimo-style notebook generation pattern: create clear, insertable notebook cells, split logic into readable cells, and use explicit notebook context instead of guessing.',
    '',
    'Return only a JSON object with this exact shape:',
    '{"cells":[{"cellType":"markdown","source":"..."},{"cellType":"code","source":"...","language":"python"}]}',
    '',
    'Rules:',
    '- Generate one or more cells; use markdown cells for headings, explanations, assumptions, and interpretation.',
    '- Use code cells for executable work. The code cell source must be raw code only, without Markdown fences or commentary.',
    '- Markdown cells must be raw Jupyter markdown, not mo.md(...) or any other wrapper.',
    '- Do not answer conversationally. Every useful answer must be represented as an insertable cell.',
    '- The user may reference context as @kind://name or @name. Use the selected references when they are relevant.',
    '- You may reference variables from earlier cells, but avoid redefining existing variables unless the user asks for that.',
    '- Keep generated code self-contained relative to the notebook context and current working directory.',
    '',
    `Target language: ${language}`,
    `Notebook: ${input.notebookPath}`,
    `Insert position: before cell ${input.insertionIndex + 1} (or append if that index is after the end).`,
    '',
    languageRules(language),
    '',
    '@ context references selected by the user:',
    notebookContextReferencePrompt(input.references),
    '',
    'User requirement:',
    input.userPrompt,
    '',
    'Nearby notebook context:',
    input.nearbyContext,
    '',
    'Other notebook cells for variable/name awareness:',
    input.otherCellContext
  ].join('\n')
}

export function parseGeneratedNotebookCells(
  assistantText: string,
  defaultLanguage: string
): AnalysisNotebookGeneratedCell[] {
  const jsonCells = parseGeneratedNotebookJsonCells(assistantText, defaultLanguage)
  if (jsonCells.length > 0) return jsonCells

  const fencedCells = parseFencedNotebookCells(assistantText, defaultLanguage)
  if (fencedCells.length > 0) return fencedCells

  const source = stripGeneratedNotebookCode(assistantText)
  if (!source.trim()) return []
  const cellType = looksLikeMarkdown(source, defaultLanguage) ? 'markdown' : 'code'
  const cell = normalizeGeneratedNotebookCell(
    { cellType, source, language: defaultLanguage },
    defaultLanguage
  )
  return cell ? [cell] : []
}

export function generatedNotebookCellsSource(cells: AnalysisNotebookGeneratedCell[]): string {
  return cells.map((cell) => cell.source).join('\n\n')
}

export function notebookGenerationEmptyResultMessage(assistantText: string): string {
  const preview = truncateNotebookPromptText(assistantText, 500)
  return preview
    ? `Agent 没有返回可插入的 cell。返回片段: ${preview}`
    : 'Agent 没有返回可插入的 cell'
}

function parseGeneratedNotebookJsonCells(
  assistantText: string,
  defaultLanguage: string
): AnalysisNotebookGeneratedCell[] {
  for (const jsonText of notebookJsonCandidates(assistantText)) {
    try {
      const parsed = JSON.parse(jsonText) as unknown
      const cells = cellsFromParsedNotebookGeneration(parsed, defaultLanguage)
      if (cells.length > 0) return cells
    } catch {
      // Try the next candidate, then fall through to fenced/raw parsing.
    }
  }
  return []
}

function cellsFromParsedNotebookGeneration(
  parsed: unknown,
  defaultLanguage: string
): AnalysisNotebookGeneratedCell[] {
  if (!parsed || typeof parsed !== 'object') return []
  if (Array.isArray(parsed)) {
    return normalizeGeneratedNotebookCells(parsed, defaultLanguage)
  }

  const record = parsed as Record<string, unknown>
  if (Array.isArray(record.cells)) {
    return normalizeGeneratedNotebookCells(record.cells, defaultLanguage)
  }
  if (Array.isArray(record.cellUpdates)) {
    return normalizeGeneratedNotebookCells(record.cellUpdates, defaultLanguage)
  }
  if (Array.isArray(record.data)) {
    return normalizeGeneratedNotebookCells(record.data, defaultLanguage)
  }
  const singleCell = normalizeGeneratedNotebookCell(record, defaultLanguage)
  return singleCell ? [singleCell] : []
}

function normalizeGeneratedNotebookCells(
  rawCells: unknown[],
  defaultLanguage: string
): AnalysisNotebookGeneratedCell[] {
  return rawCells
    .map((cell) => normalizeGeneratedNotebookCell(cell, defaultLanguage))
    .filter((cell): cell is AnalysisNotebookGeneratedCell => Boolean(cell))
}

function normalizeGeneratedNotebookCell(
  input: unknown,
  defaultLanguage: string
): AnalysisNotebookGeneratedCell | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const rawLanguage = stringField(record.language) ?? stringField(record.lang) ?? defaultLanguage
  const language = normalizeLanguage(rawLanguage)
  const rawCellType =
    stringField(record.cellType) ??
    stringField(record.cell_type) ??
    stringField(record.type) ??
    stringField(record.kind)
  const cellType = normalizeGeneratedCellType(rawCellType, language, defaultLanguage)
  const rawSource =
    stringField(record.source) ??
    stringField(record.code) ??
    stringField(record.content) ??
    stringField(record.text) ??
    ''
  const source = cleanGeneratedCellSource(rawSource, cellType)
  if (!source.trim()) return null
  return cellType === 'code' ? { cellType, source, language } : { cellType, source }
}

function parseFencedNotebookCells(
  assistantText: string,
  defaultLanguage: string
): AnalysisNotebookGeneratedCell[] {
  const trimmed = assistantText.trim()
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g
  const cells: AnalysisNotebookGeneratedCell[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = fencePattern.exec(trimmed))) {
    const prose = trimmed.slice(lastIndex, match.index).trim()
    if (prose) {
      cells.push({ cellType: 'markdown', source: prose })
    }

    const language = normalizeLanguage(match[1].trim() || defaultLanguage)
    const cellType = markdownLanguages.has(language) ? 'markdown' : 'code'
    const source = cleanGeneratedCellSource(match[2].trimEnd(), cellType)
    if (source.trim()) {
      cells.push(cellType === 'code' ? { cellType, source, language } : { cellType, source })
    }
    lastIndex = fencePattern.lastIndex
  }

  const trailing = trimmed.slice(lastIndex).trim()
  if (trailing && cells.length > 0) {
    cells.push({ cellType: 'markdown', source: trailing })
  }
  return cells
}

function notebookJsonCandidates(source: string): string[] {
  const candidates: string[] = []
  const trimmed = source.trim()
  if (trimmed) candidates.push(stripGeneratedNotebookJson(trimmed))

  for (const match of trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim())
  }

  const objectCandidate = extractBalancedJson(trimmed, '{', '}')
  if (objectCandidate) candidates.push(objectCandidate)
  const arrayCandidate = extractBalancedJson(trimmed, '[', ']')
  if (arrayCandidate) candidates.push(arrayCandidate)

  return [...new Set(candidates.filter(Boolean))]
}

function extractBalancedJson(source: string, open: '{' | '[', close: '}' | ']'): string | null {
  const start = source.indexOf(open)
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaping = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaping) {
        escaping = false
      } else if (char === '\\') {
        escaping = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === open) {
      depth += 1
    } else if (char === close) {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return null
}

function stripGeneratedNotebookJson(source: string): string {
  const trimmed = source.trim()
  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)```/i)
  if (!fence) return trimmed
  const before = trimmed.slice(0, fence.index).trim()
  const after = trimmed.slice((fence.index ?? 0) + fence[0].length).trim()
  return before || after ? trimmed : fence[1].trim()
}

function stripGeneratedNotebookCode(source: string): string {
  const trimmed = source.trim()
  const fence = trimmed.match(/```(?:[A-Za-z0-9_+-]+)?\s*\n([\s\S]*?)```/)
  if (!fence) return trimmed
  const before = trimmed.slice(0, fence.index).trim()
  const after = trimmed.slice((fence.index ?? 0) + fence[0].length).trim()
  return before || after ? trimmed : fence[1].trimEnd()
}

function cleanGeneratedCellSource(source: string, cellType: 'code' | 'markdown'): string {
  const trimmed = stripGeneratedNotebookCode(source).trimEnd()
  return cellType === 'markdown' ? unwrapMarimoMarkdown(trimmed) : trimmed
}

function unwrapMarimoMarkdown(source: string): string {
  const match = source.match(/^mo\.md\(\s*(?:r|f|fr|rf)?("""|''')([\s\S]*)\1\s*\)$/)
  return match ? match[2].trim() : source
}

function normalizeGeneratedCellType(
  rawCellType: string | undefined,
  language: string,
  defaultLanguage: string
): 'code' | 'markdown' {
  const normalized = rawCellType?.trim().toLowerCase()
  if (normalized === 'markdown' || normalized === 'md') return 'markdown'
  if (
    normalized === 'code' ||
    normalized === 'python' ||
    normalized === 'r' ||
    normalized === 'sql'
  ) {
    return 'code'
  }
  if (
    markdownLanguages.has(language) ||
    markdownLanguages.has(normalizeLanguage(defaultLanguage))
  ) {
    return 'markdown'
  }
  return 'code'
}

function normalizeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase()
  if (normalized === 'py') return 'python'
  if (normalized === 'md') return 'markdown'
  return normalized || 'python'
}

function looksLikeMarkdown(source: string, defaultLanguage: string): boolean {
  if (markdownLanguages.has(normalizeLanguage(defaultLanguage))) return true
  const trimmed = source.trim()
  if (/^(#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|>|\|.+\|)/m.test(trimmed)) return true
  if (
    /^(import|from|def|class|for|while|if|with|try|return|print|library|df\.|[A-Za-z_]\w*\s*=)/m.test(
      trimmed
    )
  ) {
    return false
  }
  if (/[=(){}[\];]/.test(trimmed)) return false
  return /[\u4e00-\u9fff]|[.!?。！？]/.test(trimmed)
}

function languageRules(language: string): string {
  if (language === 'python') {
    return [
      'Python rules:',
      '1. Prefer pandas/numpy idioms when working with dataframes.',
      '2. For matplotlib, leave the axes or figure as the last expression instead of calling plt.show().',
      '3. For plotly/altair, leave the figure/chart object as the last expression.',
      '4. If an import or variable already exists in the notebook context, reuse it instead of duplicating or redefining it.'
    ].join('\n')
  }
  if (language === 'r') {
    return [
      'R rules:',
      '1. Prefer tidy, explicit data-frame operations.',
      '2. For ggplot2, leave the plot object as the last expression.',
      '3. If a package import or variable already exists in the notebook context, reuse it instead of duplicating or redefining it.'
    ].join('\n')
  }
  if (language === 'sql') {
    return [
      'SQL rules:',
      '1. Generate complete SQL statements and name any result variables clearly.'
    ].join('\n')
  }
  return [
    'Markdown rules:',
    '1. Use raw Jupyter markdown.',
    '2. Use double dollar signs for mathematical expressions when math is needed.'
  ].join('\n')
}

function indentBlock(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return value
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
