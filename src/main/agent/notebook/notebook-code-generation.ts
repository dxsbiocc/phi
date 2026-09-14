import type { NotebookDocument } from '../../../shared/notebookDocument'
import { normalizeNotebookGenerationLanguage as normalizeLanguage } from '../../../shared/notebookCodeGeneration'

export {
  generatedNotebookCellsSource,
  notebookGenerationEmptyResultMessage,
  parseGeneratedNotebookCells,
  parseGeneratedNotebookCompletion
} from '../../../shared/notebookCodeGeneration'
export type { AnalysisNotebookGeneratedCell } from '../../../shared/notebookCodeGeneration'

export type AnalysisNotebookCodeGenerationInput = {
  prompt: string
  language: string
  model?: {
    providerId: string
    modelId: string
  } | null
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

export type NotebookPromptContext = {
  insertionIndex: number
  nearbyContext: string
  otherCellContext: string
}

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
    'Use the marimo notebook completion pattern: create clear, insertable notebook cells, split logic into readable cells, and use explicit notebook context instead of guessing.',
    'Your goal is to create new notebook cells, not to chat about what you will do.',
    'You can create multiple cells with different languages.',
    '',
    "Return only a JSON object matching marimo's NotebookCellsCompletion schema:",
    '{"cells":[{"language":"markdown","code":"raw markdown only"},{"language":"python","code":"raw code only"}]}',
    '',
    'Rules:',
    '- Generate one or more cells. Each cell must have a language and code field.',
    '- For ordinary executable requests, prefer multiple cells: a short markdown cell that explains the purpose/approach, followed by one or more target-language code cells.',
    '- Do not collapse markdown explanation and executable code into one code cell.',
    '- For executable work, use the target language and put raw code in code, without Markdown fences or commentary.',
    '- For explanation cells, use language "markdown" and put raw Jupyter markdown in code, not mo.md(...) or any other wrapper.',
    '- Do not include your private reasoning, schema notes, rule restatements, or phrases like "I should" in generated cells.',
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
