import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

const DEFAULT_MAX_DEPTH = 8
const DEFAULT_MAX_ENTRIES = 2_000
const DEFAULT_MAX_NOTEBOOKS = 200

const IGNORED_DIRECTORIES = new Set([
  '.cache',
  '.git',
  '.ipynb_checkpoints',
  '.nextflow',
  '.pytest_cache',
  '.ruff_cache',
  '.snakemake',
  'node_modules',
  'renv',
  'work'
])

export interface AnalysisNotebookSummary {
  path: string
  relativePath: string
  name: string
  directory: string
  bytes: number
  modifiedAt: string
}

export interface AnalysisNotebookRegistry {
  projectCwd: string | null
  projectName?: string
  notebooks: AnalysisNotebookSummary[]
  truncated: boolean
  initialized: boolean
  message?: string
}

export interface NotebookDiscoveryOptions {
  maxDepth?: number
  maxEntries?: number
  maxNotebooks?: number
}

function displayPath(path: string): string {
  return path.split(sep).join('/')
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith(sep))
}

function projectRoot(workingDirectory: string): string {
  const root = realpathSync(workingDirectory)
  if (!statSync(root).isDirectory()) {
    throw new Error('项目路径不可用')
  }
  return root
}

function notebookSortKey(notebook: AnalysisNotebookSummary): string {
  const priority = notebook.relativePath.startsWith('notebooks/') ? '0' : '1'
  return `${priority}:${notebook.relativePath.toLocaleLowerCase()}`
}

export function projectAnalysisInitialized(workingDirectory: string): boolean {
  const root = projectRoot(workingDirectory)
  return existsSync(join(root, 'notebooks')) && existsSync(join(root, 'outputs'))
}

export function initializeProjectAnalysis(workingDirectory: string): {
  notebooksDir: string
  outputsDir: string
} {
  const root = projectRoot(workingDirectory)
  const notebooksDir = join(root, 'notebooks')
  const outputsDir = join(root, 'outputs')
  mkdirSync(notebooksDir, { recursive: true })
  mkdirSync(outputsDir, { recursive: true })
  return { notebooksDir, outputsDir }
}

export function listProjectNotebooks(
  workingDirectory: string,
  options: NotebookDiscoveryOptions = {}
): { notebooks: AnalysisNotebookSummary[]; truncated: boolean; initialized: boolean } {
  const root = projectRoot(workingDirectory)
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxNotebooks = options.maxNotebooks ?? DEFAULT_MAX_NOTEBOOKS
  const notebooks: AnalysisNotebookSummary[] = []
  let visitedEntries = 0
  let truncated = false

  const visit = (directory: string, depth: number): void => {
    if (truncated || depth > maxDepth) return

    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (truncated) return
      visitedEntries += 1
      if (visitedEntries > maxEntries || notebooks.length >= maxNotebooks) {
        truncated = true
        return
      }

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          visit(join(directory, entry.name), depth + 1)
        }
        continue
      }

      if (!entry.isFile() || !entry.name.toLocaleLowerCase().endsWith('.ipynb')) continue

      const absolutePath = resolve(directory, entry.name)
      let realPath: string
      try {
        realPath = realpathSync(absolutePath)
      } catch {
        continue
      }
      if (!isInsideRoot(root, realPath)) continue

      const stats = statSync(realPath)
      if (!stats.isFile()) continue
      const relativePath = displayPath(relative(root, realPath))
      notebooks.push({
        path: realPath,
        relativePath,
        name: basename(realPath),
        directory: displayPath(relative(root, directory)),
        bytes: stats.size,
        modifiedAt: stats.mtime.toISOString()
      })
    }
  }

  visit(root, 0)
  notebooks.sort((a, b) => notebookSortKey(a).localeCompare(notebookSortKey(b)))
  return {
    notebooks,
    truncated,
    initialized: projectAnalysisInitialized(root)
  }
}

export function emptyNotebookRegistry(message: string): AnalysisNotebookRegistry {
  return {
    projectCwd: null,
    notebooks: [],
    truncated: false,
    initialized: false,
    message
  }
}
