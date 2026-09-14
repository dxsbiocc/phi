import type { SyntaxLanguage } from '../../../lib/syntaxHighlight'
import type { AnalysisNotebookCompletionResult } from '../../../types'

export type NotebookEditorCompletionType =
  'class' | 'constant' | 'function' | 'keyword' | 'namespace' | 'property' | 'text' | 'variable'

export interface NotebookEditorCompletionOption {
  label: string
  type: NotebookEditorCompletionType
  detail?: string
}

const MAX_LOCAL_COMPLETIONS = 120
const MAX_KERNEL_COMPLETIONS = 200

const LANGUAGE_KEYWORDS: Partial<Record<SyntaxLanguage, string[]>> = {
  python: [
    'and',
    'as',
    'assert',
    'async',
    'await',
    'break',
    'class',
    'continue',
    'def',
    'del',
    'elif',
    'else',
    'except',
    'False',
    'finally',
    'for',
    'from',
    'global',
    'if',
    'import',
    'in',
    'is',
    'lambda',
    'None',
    'nonlocal',
    'not',
    'or',
    'pass',
    'raise',
    'return',
    'True',
    'try',
    'while',
    'with',
    'yield'
  ],
  r: [
    'break',
    'else',
    'FALSE',
    'for',
    'function',
    'if',
    'in',
    'Inf',
    'NA',
    'NaN',
    'next',
    'NULL',
    'repeat',
    'return',
    'TRUE',
    'while'
  ],
  javascript: [
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'default',
    'else',
    'export',
    'finally',
    'for',
    'function',
    'if',
    'import',
    'let',
    'return',
    'throw',
    'try',
    'while'
  ],
  typescript: [
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'default',
    'else',
    'export',
    'finally',
    'for',
    'function',
    'if',
    'import',
    'interface',
    'let',
    'return',
    'throw',
    'try',
    'type',
    'while'
  ],
  shell: [
    'case',
    'do',
    'done',
    'elif',
    'else',
    'esac',
    'fi',
    'for',
    'function',
    'if',
    'then',
    'while'
  ]
}

function localIdentifierPattern(language: SyntaxLanguage): RegExp {
  if (language === 'r') return /[A-Za-z.][A-Za-z0-9._]*/g
  if (language === 'shell') return /[A-Za-z_][A-Za-z0-9_-]*/g
  return /[A-Za-z_][A-Za-z0-9_]*/g
}

function optionTypeForKernelMatch(match: string): NotebookEditorCompletionType {
  if (match.endsWith('()') || match.endsWith('(')) return 'function'
  if (/^[A-Z][A-Za-z0-9_]*$/.test(match)) return 'class'
  if (match.includes('.')) return 'property'
  return 'variable'
}

function kernelCompletionSource(
  kernel: AnalysisNotebookCompletionResult
): 'kernel' | 'python-package' | 'python-package-member' | 'kernel+python-static' {
  const source = kernel.metadata.phiCompletionSource
  if (
    source === 'python-package' ||
    source === 'python-package-member' ||
    source === 'kernel+python-static'
  ) {
    return source
  }
  return 'kernel'
}

function completionDetailForSource(source: ReturnType<typeof kernelCompletionSource>): string {
  if (source === 'python-package') return 'Python package'
  if (source === 'python-package-member') return 'Python member'
  if (source === 'kernel+python-static') return 'kernel + Python package'
  return 'kernel'
}

function completionTypeForSource(
  match: string,
  source: ReturnType<typeof kernelCompletionSource>
): NotebookEditorCompletionType {
  if (source === 'python-package') return 'namespace'
  return optionTypeForKernelMatch(match)
}

function uniquePush(
  options: NotebookEditorCompletionOption[],
  seen: Set<string>,
  option: NotebookEditorCompletionOption
): void {
  if (!option.label || seen.has(option.label)) return
  seen.add(option.label)
  options.push(option)
}

export function localNotebookCompletionOptions({
  source,
  language
}: {
  source: string
  language: SyntaxLanguage
}): NotebookEditorCompletionOption[] {
  const options: NotebookEditorCompletionOption[] = []
  const seen = new Set<string>()

  for (const keyword of LANGUAGE_KEYWORDS[language] ?? []) {
    uniquePush(options, seen, { label: keyword, type: 'keyword' })
  }

  const pattern = localIdentifierPattern(language)
  for (const match of source.matchAll(pattern)) {
    const label = match[0]
    if ((LANGUAGE_KEYWORDS[language] ?? []).includes(label)) continue
    uniquePush(options, seen, { label, type: 'variable', detail: 'notebook cell' })
    if (options.length >= MAX_LOCAL_COMPLETIONS) break
  }

  return options
}

export function mergedNotebookCompletionOptions({
  kernel,
  local
}: {
  kernel?: AnalysisNotebookCompletionResult | null
  local: NotebookEditorCompletionOption[]
}): NotebookEditorCompletionOption[] {
  const options: NotebookEditorCompletionOption[] = []
  const seen = new Set<string>()

  if (kernel?.status === 'ok') {
    const source = kernelCompletionSource(kernel)
    for (const match of kernel.matches.slice(0, MAX_KERNEL_COMPLETIONS)) {
      uniquePush(options, seen, {
        label: match,
        type: completionTypeForSource(match, source),
        detail: completionDetailForSource(source)
      })
    }
  }

  for (const option of local) {
    uniquePush(options, seen, option)
  }

  return options
}

export function notebookCompletionRange({
  kernel,
  tokenStart,
  cursorPosition,
  sourceLength
}: {
  kernel?: AnalysisNotebookCompletionResult | null
  tokenStart: number
  cursorPosition: number
  sourceLength: number
}): { from: number; to: number } {
  const from = Math.max(0, Math.min(kernel?.cursorStart ?? tokenStart, sourceLength))
  const to = Math.max(from, Math.min(kernel?.cursorEnd ?? cursorPosition, sourceLength))
  return { from, to }
}
