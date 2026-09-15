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

type NotebookGenerationParseOptions = {
  allowOpenFence?: boolean
  allowPartialJson?: boolean
  allowProseAroundFences?: boolean
  allowRawCode?: boolean
}

export function normalizeNotebookGenerationLanguage(language: string): string {
  const normalized = language.trim().toLowerCase()
  if (normalized === 'py') return 'python'
  if (normalized === 'md') return 'markdown'
  return normalized || 'python'
}

export function parseGeneratedNotebookCells(
  assistantText: string,
  defaultLanguage: string,
  options: NotebookGenerationParseOptions = {}
): AnalysisNotebookGeneratedCell[] {
  const jsonCells = parseGeneratedNotebookJsonCells(assistantText, defaultLanguage)
  if (jsonCells.length > 0) return jsonCells

  if (options.allowPartialJson) {
    const partialJsonCells = parsePartialGeneratedNotebookJsonCells(assistantText, defaultLanguage)
    if (partialJsonCells.length > 0) return partialJsonCells
  }

  const fencedCells = parseFencedNotebookCells(assistantText, defaultLanguage, options)
  if (fencedCells.length > 0) return fencedCells

  if (options.allowProseAroundFences) {
    const embeddedFencedCells = parseEmbeddedFencedNotebookCells(assistantText, defaultLanguage)
    if (embeddedFencedCells.length > 0) return embeddedFencedCells
  }

  if (options.allowRawCode) {
    const rawCodeCells = parseRawCodeNotebookCell(assistantText, defaultLanguage)
    if (rawCodeCells.length > 0) return rawCodeCells
  }

  return []
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

export function parseGeneratedNotebookCompletionSnapshot(
  completion: unknown,
  defaultLanguage: string
): AnalysisNotebookGeneratedCell[] {
  const structuredCells = parseStructuredNotebookCompletion(completion, defaultLanguage)
  if (structuredCells.length > 0) return structuredCells

  const text = completionText(completion)
  return text
    ? parseGeneratedNotebookCells(text, defaultLanguage, {
        allowOpenFence: true,
        allowPartialJson: true
      })
    : []
}

export function parseFinalGeneratedNotebookCompletion(
  completion: unknown,
  defaultLanguage: string
): AnalysisNotebookGeneratedCell[] {
  const options: NotebookGenerationParseOptions = {
    allowProseAroundFences: true,
    allowRawCode: true
  }
  const structuredCells = parseStructuredNotebookCompletion(completion, defaultLanguage, options)
  if (structuredCells.length > 0) return structuredCells

  const text = completionText(completion)
  return text
    ? parseGeneratedNotebookCells(text, defaultLanguage, {
        allowOpenFence: false,
        allowPartialJson: false,
        allowProseAroundFences: true,
        allowRawCode: true
      })
    : []
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

function parsePartialGeneratedNotebookJsonCells(
  assistantText: string,
  defaultLanguage: string
): AnalysisNotebookGeneratedCell[] {
  const cellsStart = /["']cells["']\s*:\s*\[/.exec(assistantText)
  if (!cellsStart) return []

  const arrayStart = assistantText.indexOf('[', cellsStart.index)
  if (arrayStart < 0) return []

  const rawCells: unknown[] = []
  let objectStart = -1
  let objectDepth = 0
  let inString = false
  let quote = ''
  let escaping = false

  for (let index = arrayStart + 1; index < assistantText.length; index += 1) {
    const char = assistantText[index]
    if (inString) {
      if (escaping) {
        escaping = false
      } else if (char === '\\') {
        escaping = true
      } else if (char === quote) {
        inString = false
        quote = ''
      }
      continue
    }

    if (char === '"' || char === "'") {
      inString = true
      quote = char
      continue
    }
    if (char === '{') {
      if (objectDepth === 0) objectStart = index
      objectDepth += 1
      continue
    }
    if (char !== '}') continue

    objectDepth -= 1
    if (objectDepth === 0 && objectStart >= 0) {
      try {
        rawCells.push(JSON.parse(assistantText.slice(objectStart, index + 1)))
      } catch {
        // Ignore this candidate; it may be a non-JSON object or still incomplete.
      }
      objectStart = -1
    }
  }

  return rawCells.length > 0 ? normalizeGeneratedNotebookCells(rawCells, defaultLanguage) : []
}

function parseStructuredNotebookCompletion(
  completion: unknown,
  defaultLanguage: string,
  options: NotebookGenerationParseOptions = {}
): AnalysisNotebookGeneratedCell[] {
  if (!completion || typeof completion === 'string') return []

  if (Array.isArray(completion)) {
    if (completion.every((item) => typeof item === 'string')) return []
    const directCells = normalizeGeneratedNotebookCells(completion, defaultLanguage, options)
    if (directCells.length > 0) return directCells
    const cells = completion.flatMap((item) =>
      parseStructuredNotebookCompletion(item, defaultLanguage, options)
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
      defaultLanguage,
      options
    )
  }
  if (type && CELL_COMPLETION_DATA_TYPES.has(type)) {
    return normalizeGeneratedNotebookCells(
      [record.data ?? record.value ?? record],
      defaultLanguage,
      options
    )
  }

  const cells = cellsFromParsedNotebookGeneration(record, defaultLanguage, options)
  if (cells.length > 0) return cells

  const contentCells = parseStructuredNotebookCompletion(record.content, defaultLanguage, options)
  if (contentCells.length > 0) return contentCells
  const deltaCells = parseStructuredNotebookCompletion(record.delta, defaultLanguage, options)
  if (deltaCells.length > 0) return deltaCells
  const dataCells = parseStructuredNotebookCompletion(record.data, defaultLanguage, options)
  if (dataCells.length > 0) return dataCells
  const valueCells = parseStructuredNotebookCompletion(record.value, defaultLanguage, options)
  if (valueCells.length > 0) return valueCells
  const resultCells = parseStructuredNotebookCompletion(record.result, defaultLanguage, options)
  if (resultCells.length > 0) return resultCells
  return parseStructuredNotebookCompletion(record.message, defaultLanguage, options)
}

function cellsFromParsedNotebookGeneration(
  parsed: unknown,
  defaultLanguage: string,
  options: NotebookGenerationParseOptions = {}
): AnalysisNotebookGeneratedCell[] {
  if (!parsed || typeof parsed !== 'object') return []
  if (Array.isArray(parsed)) {
    return normalizeGeneratedNotebookCells(parsed, defaultLanguage, options)
  }

  const record = parsed as Record<string, unknown>
  if (Array.isArray(record.cells)) {
    return normalizeGeneratedNotebookCells(record.cells, defaultLanguage, options)
  }
  if (Array.isArray(record.cellUpdates)) {
    return normalizeGeneratedNotebookCells(record.cellUpdates, defaultLanguage, options)
  }
  if (Array.isArray(record.data)) {
    return normalizeGeneratedNotebookCells(record.data, defaultLanguage, options)
  }
  return []
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
  if (type === undefined && typeof record.output_text === 'string') return record.output_text
  if (typeof record.content === 'string') return record.content
  return (
    completionText(record.content) ||
    completionText(record.delta) ||
    completionText(record.data) ||
    completionText(record.value) ||
    completionText(record.result) ||
    completionText(record.output) ||
    completionText(record.outputs) ||
    completionText(record.message)
  )
}

function normalizeGeneratedNotebookCells(
  rawCells: unknown[],
  defaultLanguage: string,
  options: NotebookGenerationParseOptions = {}
): AnalysisNotebookGeneratedCell[] {
  return rawCells.flatMap((cell) =>
    normalizeGeneratedNotebookCellWithNestedContent(cell, defaultLanguage, options)
  )
}

function normalizeGeneratedNotebookCell(
  input: unknown,
  defaultLanguage: string
): AnalysisNotebookGeneratedCell | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const hasMarimoCode = sourceField(record.code) !== undefined
  const hasIpynbSource =
    stringField(record.cell_type) !== undefined && sourceField(record.source) !== undefined
  const hasInternalSource =
    stringField(record.cellType) !== undefined && sourceField(record.source) !== undefined
  if (!hasMarimoCode && !hasIpynbSource && !hasInternalSource) return null

  const rawLanguage = stringField(record.language) ?? stringField(record.lang) ?? defaultLanguage
  const language = normalizeNotebookGenerationLanguage(rawLanguage)
  const rawCellType =
    (hasInternalSource ? stringField(record.cellType) : undefined) ??
    (hasIpynbSource ? stringField(record.cell_type) : undefined) ??
    stringField(record.type) ??
    stringField(record.kind)
  const cellType = normalizeGeneratedCellType(rawCellType, language, defaultLanguage)
  const rawSource = hasMarimoCode
    ? (sourceField(record.code) ?? '')
    : (sourceField(record.source) ?? '')
  if (cellType === 'code' && containsMixedMarkdownFence(rawSource)) return null
  const source = cleanGeneratedCellSource(rawSource, cellType)
  if (!source.trim()) return null
  if (looksLikeIncompleteGeneratedCellSource(source, cellType)) return null
  return cellType === 'code' ? { cellType, source, language } : { cellType, source }
}

function normalizeGeneratedNotebookCellWithNestedContent(
  input: unknown,
  defaultLanguage: string,
  options: NotebookGenerationParseOptions = {}
): AnalysisNotebookGeneratedCell[] {
  if (options.allowProseAroundFences) {
    const rawSource = sourceFromGeneratedNotebookInput(input)
    const embeddedCells = rawSource
      ? parseGeneratedNotebookCells(rawSource, defaultLanguage, {
          allowOpenFence: false,
          allowPartialJson: false,
          allowProseAroundFences: true,
          allowRawCode: true
        })
      : []
    if (embeddedCells.length > 0) return embeddedCells
  }

  const cell = normalizeGeneratedNotebookCell(input, defaultLanguage)
  if (!cell) return []
  const nestedCells = nestedGeneratedNotebookCellsFromCell(cell, defaultLanguage, options)
  return nestedCells.length > 0 ? nestedCells : [cell]
}

function nestedGeneratedNotebookCellsFromCell(
  cell: AnalysisNotebookGeneratedCell,
  defaultLanguage: string,
  options: NotebookGenerationParseOptions = {}
): AnalysisNotebookGeneratedCell[] {
  if (cell.cellType !== 'code') return []
  return parseGeneratedNotebookCells(cell.source, cell.language ?? defaultLanguage, {
    allowOpenFence: false,
    allowPartialJson: false,
    allowProseAroundFences: Boolean(options.allowProseAroundFences),
    allowRawCode: Boolean(options.allowRawCode)
  })
}

function looksLikeIncompleteGeneratedCellSource(
  source: string,
  cellType: 'code' | 'markdown'
): boolean {
  const trimmed = source.trim()
  if (/^(?:\.{3}|…)$/.test(trimmed)) return true
  if (/(?:^|\n)\s*(?:\.{3}|…)\s*(?:\n|$)/.test(trimmed)) return true
  if (cellType === 'markdown' && /^#{1,6}\s*$/.test(trimmed)) return true
  return false
}

function parseFencedNotebookCells(
  assistantText: string,
  defaultLanguage: string,
  options: { allowOpenFence?: boolean } = {}
): AnalysisNotebookGeneratedCell[] {
  const trimmed = assistantText.trim()
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g
  const cells: AnalysisNotebookGeneratedCell[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = fencePattern.exec(trimmed))) {
    if (trimmed.slice(lastIndex, match.index).trim()) return []

    const language = normalizeNotebookGenerationLanguage(match[1].trim() || defaultLanguage)
    if (language.startsWith('json') || NOTEBOOK_CELLS_COMPLETION_DATA_TYPES.has(language)) {
      return []
    }
    const cellType = markdownLanguages.has(language) ? 'markdown' : 'code'
    const source = cleanGeneratedCellSource(match[2].trimEnd(), cellType)
    pushGeneratedNotebookCell(cells, cellType, source, language)
    lastIndex = fencePattern.lastIndex
  }

  const trailing = trimmed.slice(lastIndex).trim()
  if (options.allowOpenFence) {
    const openFence = cells.length === 0 ? trimmed.match(/^```([^\n`]*)\n([\s\S]*)$/) : null
    if (openFence) {
      const language = normalizeNotebookGenerationLanguage(openFence[1].trim() || defaultLanguage)
      if (language.startsWith('json') || NOTEBOOK_CELLS_COMPLETION_DATA_TYPES.has(language)) {
        return []
      }
      const cellType = markdownLanguages.has(language) ? 'markdown' : 'code'
      const source = cleanGeneratedCellSource(openFence[2].trimEnd(), cellType)
      pushGeneratedNotebookCell(cells, cellType, source, language)
      return cells
    }
  }
  return trailing ? [] : cells
}

function parseEmbeddedFencedNotebookCells(
  assistantText: string,
  defaultLanguage: string
): AnalysisNotebookGeneratedCell[] {
  const trimmed = assistantText.trim()
  if (!trimmed || looksLikeGenerationTranscript(trimmed)) return []

  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g
  const matches = [...trimmed.matchAll(fencePattern)].filter((match) => {
    const language = normalizeNotebookGenerationLanguage(match[1].trim() || defaultLanguage)
    return !language.startsWith('json') && !NOTEBOOK_CELLS_COMPLETION_DATA_TYPES.has(language)
  })
  if (matches.length !== 1) return []

  const [match] = matches
  const language = normalizeNotebookGenerationLanguage(match[1].trim() || defaultLanguage)
  const cellType = markdownLanguages.has(language) ? 'markdown' : 'code'
  const source = cleanGeneratedCellSource(match[2].trimEnd(), cellType)
  const cells: AnalysisNotebookGeneratedCell[] = []
  pushGeneratedNotebookCell(cells, cellType, source, language)
  return cells
}

function parseRawCodeNotebookCell(
  assistantText: string,
  defaultLanguage: string
): AnalysisNotebookGeneratedCell[] {
  const source = cleanGeneratedCellSource(assistantText, 'code')
  if (!source.trim()) return []
  if (source.includes('```')) return []
  if (looksLikeGenerationTranscript(source)) return []
  if (!looksLikeRawNotebookCode(source, defaultLanguage)) return []
  return [
    { cellType: 'code', source, language: normalizeNotebookGenerationLanguage(defaultLanguage) }
  ]
}

function looksLikeRawNotebookCode(source: string, defaultLanguage: string): boolean {
  const trimmed = source.trim()
  if (!trimmed) return false
  if (/^(?:\{|\[)/.test(trimmed)) return false
  if (/^(?:sure|certainly|here is|下面|可以|好的|当然|无法|抱歉)\b/i.test(trimmed)) return false
  if (/^(?:下面|可以|好的|当然|无法|抱歉|这里)/.test(trimmed)) return false

  const language = normalizeNotebookGenerationLanguage(defaultLanguage)
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return false
  const codeLineCount = lines.filter((line) => looksLikeCodeLine(line, language)).length
  if (codeLineCount === 0) return false
  if (lines.length === 1) return codeLineCount === 1

  const proseLineCount = lines.filter((line) => looksLikePlainProseLine(line, language)).length
  return codeLineCount >= Math.max(1, Math.ceil(lines.length / 3)) && proseLineCount <= 1
}

function looksLikeCodeLine(line: string, language: string): boolean {
  if (!line || /^#/.test(line)) return false
  if (language === 'r') {
    return (
      /^\w[\w.]*\s*(?:<-|=)\s*\S/.test(line) ||
      /(?:%>%|\|>|\$|::)/.test(line) ||
      /^\w[\w.]*\s*\([^)]*\)/.test(line) ||
      /^(?:library|require|if|for|while|function)\b/.test(line)
    )
  }
  if (language === 'sql') {
    return /^(?:select|with|insert|update|delete|create|alter|drop)\b/i.test(line)
  }
  return (
    /^(?:import|from|def|class|for|while|if|elif|else:|try:|except|with|return|raise|assert)\b/.test(
      line
    ) ||
    /^\w[\w.]*\s*(?:=|\+=|-=|\*=|\/=|:=)\s*\S/.test(line) ||
    /^(?:\w+\.)*\w+\s*\([^)]*\)/.test(line) ||
    /^\w[\w.]*\[[^\]]+\]\s*(?:=|\+=|-=|\*=|\/=)\s*\S/.test(line)
  )
}

function looksLikePlainProseLine(line: string, language: string): boolean {
  if (looksLikeCodeLine(line, language)) return false
  if (/^[-*]\s+/.test(line)) return true
  if (/[。！？；]/.test(line)) return true
  if (
    /^(?:sure|certainly|here is|this|that|the|下面|可以|好的|当然|这里|然后|接着)\b/i.test(line)
  ) {
    return true
  }
  return false
}

function looksLikeGenerationTranscript(source: string): boolean {
  return [
    /\bI need to\b/i,
    /\bI should\b/i,
    /\bLet's\b/i,
    /\bNow I can\b/i,
    /\bneed to inspect\b/i,
    /(?:我需要|我应该|先检查|让我|接下来|现在我可以|思考过程|规则要求)/
  ].some((pattern) => pattern.test(source))
}

function pushGeneratedNotebookCell(
  cells: AnalysisNotebookGeneratedCell[],
  cellType: 'code' | 'markdown',
  source: string,
  language?: string
): void {
  if (!source.trim()) return
  if (looksLikeIncompleteGeneratedCellSource(source, cellType)) return
  cells.push(cellType === 'code' ? { cellType, source, language } : { cellType, source })
}

function notebookJsonCandidates(source: string): string[] {
  const candidates: string[] = []
  const trimmed = source.trim()
  if (trimmed) candidates.push(trimmed)

  const fencePattern =
    /```(?:json|notebook-cells-completion|data-notebook-cells-completion)?\s*\n([\s\S]*?)\n?```/gi
  for (const fence of trimmed.matchAll(fencePattern)) {
    candidates.push(fence[1].trim())
  }

  candidates.push(...balancedJsonCandidates(trimmed))
  return [...new Set(candidates.filter(Boolean))]
}

function balancedJsonCandidates(source: string): string[] {
  const candidates: string[] = []
  for (let start = 0; start < source.length; start += 1) {
    const opening = source[start]
    if (opening !== '{' && opening !== '[') continue
    const closing = opening === '{' ? '}' : ']'
    const candidate = balancedJsonCandidateFrom(source, start, closing)
    if (!candidate) continue
    if (!/"(?:cells|cellUpdates|code|source)"\s*:/.test(candidate)) continue
    candidates.push(candidate)
    start += candidate.length - 1
  }
  return candidates
}

function balancedJsonCandidateFrom(
  source: string,
  start: number,
  closing: '}' | ']'
): string | null {
  const stack: string[] = []
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
      continue
    }

    if (char === '{') {
      stack.push('}')
      continue
    }
    if (char === '[') {
      stack.push(']')
      continue
    }
    if (char !== '}' && char !== ']') continue

    if (stack.at(-1) !== char) return null
    stack.pop()
    if (stack.length === 0 && char === closing) {
      return source.slice(start, index + 1)
    }
  }

  return null
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

function containsMixedMarkdownFence(source: string): boolean {
  const trimmed = source.trim()
  if (!trimmed.includes('```')) return false
  return !/^```[^\n`]*\n[\s\S]*?```\s*$/.test(trimmed)
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

function sourceFromGeneratedNotebookInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  return sourceField(record.code) ?? sourceField(record.source)
}
