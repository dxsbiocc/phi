export type AnalysisNotebookGeneratedCell = {
  cellType: 'code' | 'markdown'
  source: string
  language?: string
}

const markdownLanguages = new Set(['markdown', 'md'])
const NOTEBOOK_CELLS_COMPLETION_DATA_TYPES = new Set([
  'data-notebook-cells-completion',
  'notebook-cells-completion'
])
const CELL_COMPLETION_DATA_TYPES = new Set(['data-cell-completion', 'cell-completion'])

export function normalizeNotebookGenerationLanguage(language: string): string {
  const normalized = language.trim().toLowerCase()
  if (normalized === 'py') return 'python'
  if (normalized === 'md') return 'markdown'
  return normalized || 'python'
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
  if (looksLikeNotebookProtocolText(source)) return []
  const cellType = looksLikeMarkdown(source, defaultLanguage) ? 'markdown' : 'code'
  const cell = normalizeGeneratedNotebookCell(
    { cellType, source, language: defaultLanguage },
    defaultLanguage
  )
  return cell ? [cell] : []
}

export function parseGeneratedNotebookCompletion(
  completion: unknown,
  defaultLanguage: string
): AnalysisNotebookGeneratedCell[] {
  const structuredCells = parseStructuredNotebookCompletion(completion, defaultLanguage)
  if (structuredCells.length > 0) return structuredCells

  const text = completionText(completion)
  return text ? parseGeneratedNotebookCells(text, defaultLanguage) : []
}

export function generatedNotebookCellsSource(cells: AnalysisNotebookGeneratedCell[]): string {
  return cells.map((cell) => cell.source).join('\n\n')
}

export function notebookGenerationEmptyResultMessage(assistantText: string): string {
  const preview = truncateNotebookPromptText(assistantText, 500)
  return preview ? `AI 没有生成可插入内容。返回片段: ${preview}` : 'AI 没有生成可插入内容'
}

function truncateNotebookPromptText(value: string, maxLength: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, maxLength).trimEnd()}\n...`
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

function parseStructuredNotebookCompletion(
  completion: unknown,
  defaultLanguage: string
): AnalysisNotebookGeneratedCell[] {
  if (!completion || typeof completion === 'string') return []

  if (Array.isArray(completion)) {
    if (completion.every((item) => typeof item === 'string')) return []
    const cells = completion.flatMap((item) =>
      parseStructuredNotebookCompletion(item, defaultLanguage)
    )
    return cells.length > 0 ? cells : []
  }

  if (typeof completion !== 'object') return []
  const record = completion as Record<string, unknown>
  const type = stringField(record.type)
  if (type === 'text' || type === 'output_text' || type === 'input_text') return []
  if (type && NOTEBOOK_CELLS_COMPLETION_DATA_TYPES.has(type)) {
    return cellsFromParsedNotebookGeneration(
      record.data ?? record.value ?? record.content ?? record,
      defaultLanguage
    )
  }
  if (type && CELL_COMPLETION_DATA_TYPES.has(type)) {
    return cellsFromParsedNotebookGeneration(record.data ?? record.value ?? record, defaultLanguage)
  }

  const cells = cellsFromParsedNotebookGeneration(record, defaultLanguage)
  if (cells.length > 0) return cells

  const contentCells = parseStructuredNotebookCompletion(record.content, defaultLanguage)
  if (contentCells.length > 0) return contentCells
  return parseStructuredNotebookCompletion(record.message, defaultLanguage)
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

function completionText(completion: unknown): string {
  if (typeof completion === 'string') return completion
  if (!completion || typeof completion !== 'object') return ''
  if (Array.isArray(completion)) {
    return completion.map(completionText).join('')
  }

  const record = completion as Record<string, unknown>
  const type = stringField(record.type)
  if (
    (type === undefined ||
      type === 'text' ||
      type === 'output_text' ||
      type === 'input_text' ||
      type === 'markdown') &&
    typeof record.text === 'string'
  ) {
    return record.text
  }
  if (typeof record.content === 'string') return record.content
  return completionText(record.content) || completionText(record.message)
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
  const language = normalizeNotebookGenerationLanguage(rawLanguage)
  const rawCellType =
    stringField(record.cellType) ??
    stringField(record.cell_type) ??
    stringField(record.type) ??
    stringField(record.kind)
  const cellType = normalizeGeneratedCellType(rawCellType, language, defaultLanguage)
  const rawSource =
    sourceField(record.source) ??
    sourceField(record.code) ??
    sourceField(record.content) ??
    sourceField(record.text) ??
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

    const language = normalizeNotebookGenerationLanguage(match[1].trim() || defaultLanguage)
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
    markdownLanguages.has(normalizeNotebookGenerationLanguage(defaultLanguage))
  ) {
    return 'markdown'
  }
  return 'code'
}

function looksLikeMarkdown(source: string, defaultLanguage: string): boolean {
  if (markdownLanguages.has(normalizeNotebookGenerationLanguage(defaultLanguage))) return true
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

function looksLikeNotebookProtocolText(source: string): boolean {
  const trimmed = source.trim()
  const lower = trimmed.toLowerCase()
  if (
    /^```+\s*(json|notebook-cells-completion|data-notebook-cells-completion)?\s*$/i.test(trimmed)
  ) {
    return true
  }
  if (/^```+\s*json\b/i.test(trimmed) && /["']cells?["']\s*:/.test(trimmed)) {
    return true
  }
  if (/notebookcellscompletion|data-notebook-cells-completion|cell-completion/.test(lower)) {
    return true
  }
  if (/["']cells["']\s*:/.test(trimmed) && /["']code["']\s*:/.test(trimmed)) {
    return true
  }
  if (/^\s*[{[]/.test(trimmed) && /["']cells?["']\s*:/.test(trimmed)) {
    return true
  }
  if (/(return|返回)\s+(only\s+)?(a\s+)?json/.test(lower) && lower.includes('cells')) {
    return true
  }
  if (
    /(用户要求|user (asks|requested|requires)|我应该|i should|规则要求|rules require)/i.test(
      trimmed
    )
  ) {
    return true
  }
  return false
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function sourceField(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join('')
  }
  return undefined
}
