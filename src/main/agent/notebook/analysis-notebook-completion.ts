import type { JsonObject } from '../../../shared/notebookDocument'
import {
  listAnalysisPythonPackages,
  type AnalysisPythonPackageSummary
} from './analysis-python-packages'

export interface AnalysisNotebookCompletionLike {
  matches: string[]
  cursorStart: number
  cursorEnd: number
  metadata: JsonObject
  status: 'ok' | 'error'
  message?: string
}

type StaticCompletionContext =
  | { kind: 'import-package'; from: number; to: number; prefix: string }
  | { kind: 'from-package'; from: number; to: number; prefix: string }
  | { kind: 'from-member'; from: number; to: number; moduleName: string; prefix: string }
  | { kind: 'member'; from: number; to: number; expression: string; prefix: string }

const COMMON_PYTHON_PACKAGES = [
  'altair',
  'bokeh',
  'cv2',
  'dask',
  'geopandas',
  'matplotlib',
  'matplotlib.pyplot',
  'networkx',
  'numpy',
  'pandas',
  'plotly',
  'plotly.express',
  'polars',
  'pyarrow',
  'scipy',
  'scipy.optimize',
  'scipy.sparse',
  'scipy.stats',
  'seaborn',
  'skimage',
  'sklearn',
  'sklearn.cluster',
  'sklearn.decomposition',
  'sklearn.ensemble',
  'sklearn.linear_model',
  'sklearn.metrics',
  'sklearn.model_selection',
  'sklearn.pipeline',
  'sklearn.preprocessing',
  'statsmodels',
  'tensorflow',
  'torch',
  'xarray'
]

const COMMON_MEMBER_COMPLETIONS: Record<string, string[]> = {
  'matplotlib.pyplot': [
    'figure',
    'hist',
    'imshow',
    'legend',
    'plot',
    'savefig',
    'scatter',
    'show',
    'subplots',
    'tight_layout',
    'title',
    'xlabel',
    'ylabel'
  ],
  numpy: [
    'arange',
    'array',
    'concatenate',
    'dot',
    'isnan',
    'linalg',
    'linspace',
    'mean',
    'median',
    'nan',
    'ones',
    'random',
    'reshape',
    'std',
    'sum',
    'where',
    'zeros'
  ],
  pandas: [
    'DataFrame',
    'Series',
    'concat',
    'crosstab',
    'date_range',
    'isna',
    'merge',
    'notna',
    'pivot_table',
    'read_csv',
    'read_excel',
    'read_json',
    'to_datetime'
  ],
  'plotly.express': ['bar', 'box', 'histogram', 'imshow', 'line', 'scatter'],
  scipy: ['linalg', 'optimize', 'signal', 'sparse', 'stats'],
  seaborn: [
    'boxplot',
    'catplot',
    'heatmap',
    'histplot',
    'lineplot',
    'pairplot',
    'scatterplot',
    'set_theme'
  ],
  sklearn: [
    'cluster',
    'decomposition',
    'ensemble',
    'linear_model',
    'metrics',
    'model_selection',
    'pipeline',
    'preprocessing',
    'svm'
  ],
  'sklearn.model_selection': [
    'GridSearchCV',
    'KFold',
    'StratifiedKFold',
    'cross_val_score',
    'train_test_split'
  ],
  tensorflow: ['GradientTape', 'Variable', 'constant', 'data', 'keras'],
  torch: [
    'Tensor',
    'cuda',
    'device',
    'from_numpy',
    'nn',
    'no_grad',
    'optim',
    'randn',
    'tensor',
    'zeros'
  ]
}

function currentLineContext(
  source: string,
  cursorPosition: number
): { lineBeforeCursor: string; lineStart: number } {
  const position = Math.max(0, Math.min(cursorPosition, source.length))
  const lineStart = source.lastIndexOf('\n', position - 1) + 1
  return {
    lineBeforeCursor: source.slice(lineStart, position),
    lineStart
  }
}

function importAliasMap(source: string): Map<string, string> {
  const aliases = new Map<string, string>()
  const importPattern = /^\s*import\s+(.+)$/gm
  for (const match of source.matchAll(importPattern)) {
    const imports = match[1].split(',')
    for (const rawImport of imports) {
      const item = rawImport
        .trim()
        .match(/^([A-Za-z_][A-Za-z0-9_.]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/)
      if (!item) continue
      aliases.set(item[2] ?? item[1].split('.')[0], item[1])
    }
  }

  const fromImportPattern = /^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+(.+)$/gm
  for (const match of source.matchAll(fromImportPattern)) {
    const moduleName = match[1]
    for (const rawImport of match[2].split(',')) {
      const item = rawImport
        .trim()
        .match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/)
      if (!item) continue
      aliases.set(item[2] ?? item[1], `${moduleName}.${item[1]}`)
    }
  }
  return aliases
}

function staticCompletionContext(
  source: string,
  cursorPosition: number
): StaticCompletionContext | null {
  const position = Math.max(0, Math.min(cursorPosition, source.length))
  const { lineBeforeCursor } = currentLineContext(source, position)
  const importMatch = lineBeforeCursor.match(/^\s*import\s+(.+)$/)
  if (importMatch && !/\bas\s+[A-Za-z_][A-Za-z0-9_]*$/.test(importMatch[1])) {
    const token = importMatch[1].split(',').at(-1)?.trimStart() ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(token) || token === '') {
      return {
        kind: 'import-package',
        from: position - token.length,
        to: position,
        prefix: token
      }
    }
  }

  const fromMemberMatch = lineBeforeCursor.match(
    /^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+([A-Za-z_][A-Za-z0-9_]*)?$/
  )
  if (fromMemberMatch) {
    const prefix = fromMemberMatch[2] ?? ''
    return {
      kind: 'from-member',
      from: position - prefix.length,
      to: position,
      moduleName: fromMemberMatch[1],
      prefix
    }
  }

  const fromPackageMatch = lineBeforeCursor.match(/^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)?$/)
  if (fromPackageMatch) {
    const prefix = fromPackageMatch[1] ?? ''
    return {
      kind: 'from-package',
      from: position - prefix.length,
      to: position,
      prefix
    }
  }

  const memberMatch = lineBeforeCursor.match(
    /([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)?$/
  )
  if (memberMatch) {
    const prefix = memberMatch[2] ?? ''
    return {
      kind: 'member',
      from: position - prefix.length,
      to: position,
      expression: memberMatch[1],
      prefix
    }
  }

  return null
}

function uniqueSortedMatches(matches: string[], maxMatches = 240): string[] {
  return [...new Set(matches)]
    .filter((match) => match.length > 0)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maxMatches)
}

function packageMatches(packages: AnalysisPythonPackageSummary[], prefix: string): string[] {
  const normalizedPrefix = prefix.toLocaleLowerCase()
  const installed = packages
    .map((entry) => entry.name)
    .filter((name) => name.toLocaleLowerCase().startsWith(normalizedPrefix))
  const common = COMMON_PYTHON_PACKAGES.filter((name) =>
    name.toLocaleLowerCase().startsWith(normalizedPrefix)
  )
  return uniqueSortedMatches([...installed, ...common])
}

function aliasModuleName(source: string, expression: string): string {
  const aliases = importAliasMap(source)
  const [root, ...rest] = expression.split('.')
  const rootModule = aliases.get(root) ?? root
  return [rootModule, ...rest].join('.')
}

function memberMatches(source: string, expression: string, prefix: string): string[] {
  const moduleName = aliasModuleName(source, expression)
  const normalizedPrefix = prefix.toLocaleLowerCase()
  return uniqueSortedMatches(
    (COMMON_MEMBER_COMPLETIONS[moduleName] ?? []).filter((name) =>
      name.toLocaleLowerCase().startsWith(normalizedPrefix)
    )
  )
}

function completionResult(
  matches: string[],
  context: StaticCompletionContext,
  source: 'python-package' | 'python-package-member'
): AnalysisNotebookCompletionLike | null {
  if (matches.length === 0) return null
  return {
    matches,
    cursorStart: context.from,
    cursorEnd: context.to,
    metadata: { phiCompletionSource: source },
    status: 'ok'
  }
}

export function completeNotebookPythonStaticCompletion(
  input: { projectCwd: string; source: string; cursorPosition: number },
  options: {
    packageProvider?: (projectCwd: string) => AnalysisPythonPackageSummary[]
  } = {}
): AnalysisNotebookCompletionLike | null {
  const context = staticCompletionContext(input.source, input.cursorPosition)
  if (!context) return null

  if (context.kind === 'member') {
    return completionResult(
      memberMatches(input.source, context.expression, context.prefix),
      context,
      'python-package-member'
    )
  }

  if (context.kind === 'from-member') {
    return completionResult(
      memberMatches(input.source, context.moduleName, context.prefix),
      context,
      'python-package-member'
    )
  }

  const packages =
    options.packageProvider?.(input.projectCwd) ??
    listAnalysisPythonPackages({ projectCwd: input.projectCwd }).packages
  return completionResult(packageMatches(packages, context.prefix), context, 'python-package')
}

export function mergeNotebookCompletionResults(
  primary: AnalysisNotebookCompletionLike,
  fallback: AnalysisNotebookCompletionLike | null
): AnalysisNotebookCompletionLike {
  if (!fallback) return primary
  if (primary.status !== 'ok' || primary.matches.length === 0) return fallback
  if (primary.cursorStart !== fallback.cursorStart || primary.cursorEnd !== fallback.cursorEnd) {
    return primary
  }

  return {
    ...primary,
    matches: [...new Set([...primary.matches, ...fallback.matches])],
    metadata: {
      ...primary.metadata,
      phiCompletionSource: 'kernel+python-static'
    }
  }
}
