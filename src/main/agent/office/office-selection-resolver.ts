import type { OfficeSelectionSummary } from '../../../shared/officeProtocol'
import { officeCliEnv, runOfficeCli, type OfficeCliRunResult } from './office-driver'
import { resolvedSelectionFromPaths } from './office-selection-events'

const MAX_SELECTION_CELLS = 10_000

export interface OfficeResolvedSelection extends OfficeSelectionSummary {
  resolvedAt: string
}

export type OfficeSelectionErrorCode = 'selection_unavailable' | 'selection_too_large'

export class OfficeSelectionError extends Error {
  constructor(
    readonly code: OfficeSelectionErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'OfficeSelectionError'
  }
}

interface ResolveOfficeSelectionDependencies {
  run?: typeof runOfficeCli
  now?: () => Date
}

function parsedJson(result: OfficeCliRunResult): unknown {
  if (result.spawnError || result.timedOut || result.truncated || result.exitCode !== 0) {
    throw new OfficeSelectionError(
      'selection_unavailable',
      '无法读取当前选区，请重新选择或清除选区'
    )
  }
  try {
    const value = JSON.parse(result.stdout) as { success?: unknown }
    if (value.success !== true) throw new Error('unsuccessful')
    return value
  } catch (error) {
    if (error instanceof OfficeSelectionError) throw error
    throw new OfficeSelectionError(
      'selection_unavailable',
      '无法读取当前选区，请重新选择或清除选区'
    )
  }
}

function selectedPaths(value: unknown): string[] {
  const data = (value as { data?: { matches?: unknown; results?: unknown } }).data
  if (!data || !Array.isArray(data.results) || !Number.isSafeInteger(data.matches)) {
    throw new OfficeSelectionError(
      'selection_unavailable',
      '无法读取当前选区，请重新选择或清除选区'
    )
  }
  if (data.matches !== data.results.length) {
    throw new OfficeSelectionError(
      'selection_unavailable',
      '无法读取当前选区，请重新选择或清除选区'
    )
  }
  return data.results.map((result) => {
    const node = result as { path?: unknown; type?: unknown }
    if (typeof node.path !== 'string' || (node.type !== 'cell' && node.type !== 'range')) {
      throw new OfficeSelectionError(
        'selection_unavailable',
        '无法读取当前选区，请重新选择或清除选区'
      )
    }
    return node.path
  })
}

function workbookSheets(value: unknown): Set<string> {
  const results = (value as { data?: { results?: unknown } }).data?.results
  const children = Array.isArray(results)
    ? (results[0] as { path?: unknown; type?: unknown; children?: unknown } | undefined)
    : undefined
  if (children?.path !== '/' || children.type !== 'workbook' || !Array.isArray(children.children)) {
    throw new OfficeSelectionError(
      'selection_unavailable',
      '无法读取当前选区，请重新选择或清除选区'
    )
  }
  const names = children.children.map((sheet) => {
    const node = sheet as { path?: unknown; type?: unknown }
    return node.type === 'sheet' && typeof node.path === 'string' && node.path.startsWith('/')
      ? node.path.slice(1)
      : undefined
  })
  if (names.some((name) => !name || name.includes('/'))) {
    throw new OfficeSelectionError(
      'selection_unavailable',
      '无法读取当前选区，请重新选择或清除选区'
    )
  }
  return new Set(names as string[])
}

function assertSelectionSheets(
  selection: OfficeSelectionSummary,
  sheets: ReadonlySet<string>
): void {
  const selectedSheets = selection.paths.map((path) => path.slice(1, path.indexOf('/', 1)))
  if (selectedSheets.some((sheet) => !sheets.has(sheet))) {
    throw new OfficeSelectionError(
      'selection_unavailable',
      '无法读取当前选区，请重新选择或清除选区'
    )
  }
}

export async function resolveOfficeSelection(
  binaryPath: string,
  draftPath: string,
  dependencies: ResolveOfficeSelectionDependencies = {}
): Promise<OfficeResolvedSelection | null> {
  const run = dependencies.run ?? runOfficeCli
  const options = { env: officeCliEnv() }
  const selected = parsedJson(
    await run(binaryPath, ['get', draftPath, 'selected', '--json'], options)
  )
  const paths = selectedPaths(selected)
  if (paths.length === 0) return null
  const parsed = resolvedSelectionFromPaths(paths)
  if (!parsed) {
    throw new OfficeSelectionError(
      'selection_unavailable',
      '无法读取当前选区，请重新选择或清除选区'
    )
  }
  if (parsed.cellCount > MAX_SELECTION_CELLS) {
    throw new OfficeSelectionError(
      'selection_too_large',
      '当前选区超过 10,000 个单元格，请缩小选区'
    )
  }
  const workbook = parsedJson(
    await run(binaryPath, ['get', draftPath, '/', '--depth', '1', '--json'], options)
  )
  assertSelectionSheets(parsed.summary, workbookSheets(workbook))
  return {
    ...parsed.summary,
    paths: [...parsed.summary.paths],
    resolvedAt: (dependencies.now ?? (() => new Date()))().toISOString()
  }
}
