import { spawnSync } from 'node:child_process'

export type AnalysisNotebookFormatter = 'ruff' | 'black' | 'none'

export interface AnalysisNotebookFormatInput {
  projectCwd: string
  source: string
  language?: string
  lineLength?: number
}

export interface AnalysisNotebookFormatResult {
  source: string
  changed: boolean
  formatter: AnalysisNotebookFormatter
  message?: string
}

export interface NotebookFormatterRunOptions {
  cwd: string
  input: string
  timeoutMs: number
}

export interface NotebookFormatterRunResult {
  status: number | null
  stdout: string
  stderr: string
  errorCode?: string
}

export type NotebookFormatterRunner = (
  command: string,
  args: string[],
  options: NotebookFormatterRunOptions
) => NotebookFormatterRunResult

const FORMATTER_TIMEOUT_MS = 10_000
const MAX_FORMATTER_OUTPUT_BYTES = 2 * 1024 * 1024

function normalizeLanguage(language: string | undefined): string {
  return language?.trim().toLocaleLowerCase() ?? ''
}

function isPythonLikeLanguage(language: string | undefined): boolean {
  const normalized = normalizeLanguage(language)
  return normalized === 'python' || normalized.startsWith('python')
}

function defaultFormatterRunner(
  command: string,
  args: string[],
  options: NotebookFormatterRunOptions
): NotebookFormatterRunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    maxBuffer: MAX_FORMATTER_OUTPUT_BYTES,
    timeout: options.timeoutMs
  })
  const error = result.error as NodeJS.ErrnoException | undefined
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    errorCode: error?.code
  }
}

function formatterMissing(result: NotebookFormatterRunResult): boolean {
  if (result.errorCode === 'ENOENT') return true
  return /No module named black|command not found|not found/i.test(result.stderr)
}

function formatterMessage(result: NotebookFormatterRunResult): string {
  return (result.stderr || result.stdout || 'formatter exited without output').trim().slice(0, 500)
}

export function formatNotebookCellSource(
  input: AnalysisNotebookFormatInput,
  options: { runner?: NotebookFormatterRunner } = {}
): AnalysisNotebookFormatResult {
  const source = input.source
  if (!isPythonLikeLanguage(input.language)) {
    return {
      source,
      changed: false,
      formatter: 'none',
      message: 'Only Python notebook cell formatting is currently supported.'
    }
  }

  const runner = options.runner ?? defaultFormatterRunner
  const lineLength = Math.max(40, Math.min(input.lineLength ?? 88, 200))
  const candidates: Array<{
    formatter: Exclude<AnalysisNotebookFormatter, 'none'>
    command: string
    args: string[]
  }> = [
    {
      formatter: 'ruff',
      command: 'ruff',
      args: ['format', '--line-length', String(lineLength), '--stdin-filename', 'cell.py', '-']
    },
    {
      formatter: 'black',
      command: 'python',
      args: ['-m', 'black', '--quiet', '--line-length', String(lineLength), '-']
    },
    {
      formatter: 'black',
      command: 'python3',
      args: ['-m', 'black', '--quiet', '--line-length', String(lineLength), '-']
    }
  ]
  let lastFailure: string | undefined

  for (const candidate of candidates) {
    const result = runner(candidate.command, candidate.args, {
      cwd: input.projectCwd,
      input: source,
      timeoutMs: FORMATTER_TIMEOUT_MS
    })
    if (result.status === 0 && result.stdout.length > 0) {
      return {
        source: result.stdout,
        changed: result.stdout !== source,
        formatter: candidate.formatter
      }
    }
    if (formatterMissing(result)) {
      lastFailure = formatterMessage(result)
      continue
    }
    lastFailure = formatterMessage(result)
  }

  return {
    source,
    changed: false,
    formatter: 'none',
    message:
      lastFailure ??
      'No Python formatter was found. Install ruff or black in the project environment.'
  }
}
