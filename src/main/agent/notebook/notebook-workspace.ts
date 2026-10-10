import { createHash } from 'node:crypto'
import { isAbsolute, posix, resolve, sep } from 'node:path'

import {
  parseNotebook,
  serializeNotebook,
  type NotebookDocument
} from '../../../shared/notebookDocument'
import { LocalHost } from '../workspace-host/local-host'
import type { WorkspaceHost, WorkspaceStat } from '../workspace-host/types'
import type { AnalysisNotebookSummary, NotebookDiscoveryOptions } from './analysis-notebooks'
import {
  createEmptyNotebookDocument,
  type AnalysisNotebookFile,
  type DeleteProjectNotebookResult,
  type SaveProjectNotebookInput
} from './analysis-notebook-files'
import { watchHostNotebook } from './analysis-notebook-watch'

export const MAX_NOTEBOOK_FILE_BYTES = 1024 * 1024
const [READ_CHUNK_BYTES, DEFAULT_POLL_INTERVAL_MS] = [256 * 1024, 2_000]

export type NotebookWorkspaceList = {
  notebooks: AnalysisNotebookSummary[]
  truncated: boolean
  initialized: boolean
}

export type NotebookWorkspaceWatchEvent =
  | { type: 'changed'; file: AnalysisNotebookFile }
  | { type: 'deleted'; path: string; relativePath: string }
  | { type: 'error'; path: string; relativePath: string; message: string }

export interface NotebookWorkspaceWatchSubscription {
  close(): Promise<void>
}

export interface NotebookWorkspace {
  readonly projectCwd: string
  list(options?: NotebookDiscoveryOptions): Promise<NotebookWorkspaceList>
  open(path: string): Promise<AnalysisNotebookFile>
  create(relativePath?: string): Promise<AnalysisNotebookFile>
  save(input: SaveProjectNotebookInput): Promise<AnalysisNotebookFile>
  close(path: string): Promise<{ path: string }>
  delete(path: string): Promise<DeleteProjectNotebookResult>
  watch(
    path: string,
    listener: (event: NotebookWorkspaceWatchEvent) => void,
    options?: { pollIntervalMs?: number }
  ): Promise<NotebookWorkspaceWatchSubscription>
}

type WorkspacePath = { relativePath: string; path: string }

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function sha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function assertNotebookExtension(path: string): void {
  if (!path.toLocaleLowerCase().endsWith('.ipynb')) {
    throw new Error('只能操作 .ipynb notebook')
  }
}

function notebookConflict(): Error {
  return new Error('Notebook 已在磁盘上变化，请重新打开后再保存')
}

function normalizedRelativePath(projectCwd: string, path: string): string {
  if (!path || path.includes('\0')) throw new Error('只能操作当前项目内的 notebook')
  const portablePath = path.split(sep).join('/')
  const portableRoot = projectCwd.split(sep).join('/')
  const candidate =
    isAbsolute(path) || posix.isAbsolute(portablePath)
      ? posix.relative(portableRoot, portablePath)
      : portablePath
  const normalized = posix.normalize(candidate)
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    posix.isAbsolute(normalized)
  ) {
    throw new Error('只能操作当前项目内的 notebook')
  }
  return normalized
}

function workspacePath(projectCwd: string, path: string): WorkspacePath {
  const relativePath = normalizedRelativePath(projectCwd, path)
  assertNotebookExtension(relativePath)
  return { relativePath, path: resolve(projectCwd, relativePath) }
}

function modifiedAt(stat: WorkspaceStat): string {
  const value = stat.modifiedAt
  return value && Number.isFinite(Date.parse(value)) ? value : new Date(0).toISOString()
}

function isMissingError(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? String(error.code) : ''
  const message = errorMessage(error).toLocaleLowerCase()
  return (
    code === 'ENOENT' ||
    ['does not exist', 'missing', '不存在'].some((text) => message.includes(text))
  )
}

function isSkippableTraversalError(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? String(error.code) : ''
  return isMissingError(error) || ['EACCES', 'EPERM', 'PATH_OUTSIDE_ROOT'].includes(code)
}

async function isDirectory(host: WorkspaceHost, path: string): Promise<boolean> {
  try {
    return (await host.fs.stat(path)).kind === 'directory'
  } catch (error) {
    if (isSkippableTraversalError(error)) return false
    throw error
  }
}

async function pathExists(host: WorkspaceHost, path: string): Promise<boolean> {
  try {
    await host.fs.stat(path)
    return true
  } catch (error) {
    if (isMissingError(error)) return false
    throw error
  }
}

async function readNotebookBytes(host: WorkspaceHost, path: string): Promise<Uint8Array> {
  const stat = await host.fs.stat(path)
  if (stat.kind !== 'file') throw new Error('Notebook 文件不可用')
  if (stat.size > MAX_NOTEBOOK_FILE_BYTES) throw new Error('Notebook 文件超过 1 MiB 上限')
  const chunks: Uint8Array[] = []
  let offset = 0
  while (offset <= MAX_NOTEBOOK_FILE_BYTES) {
    const result = await host.fs.readRange(path, { offset, length: READ_CHUNK_BYTES })
    if (result.bytesRead !== result.content.byteLength) {
      throw new Error('Notebook 文件读取结果无效')
    }
    chunks.push(result.content)
    offset += result.bytesRead
    if (result.eof) break
    if (result.bytesRead === 0 || offset > MAX_NOTEBOOK_FILE_BYTES) {
      throw new Error('Notebook 文件超过 1 MiB 上限')
    }
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  if (bytes.byteLength > MAX_NOTEBOOK_FILE_BYTES) throw new Error('Notebook 文件超过 1 MiB 上限')
  return bytes
}

function parseNotebookBytes(bytes: Uint8Array): NotebookDocument {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return parseNotebook(JSON.parse(text))
}

function serializeNotebookBytes(document: NotebookDocument): Uint8Array {
  const text = `${JSON.stringify(serializeNotebook(document), null, 2)}\n`
  const bytes = Buffer.from(text, 'utf-8')
  if (bytes.byteLength > MAX_NOTEBOOK_FILE_BYTES) throw new Error('Notebook 文件超过 1 MiB 上限')
  return bytes
}

function notebookFile(
  target: WorkspacePath,
  bytes: Uint8Array,
  stat: WorkspaceStat
): AnalysisNotebookFile {
  const document = parseNotebookBytes(bytes)
  return {
    path: target.path,
    relativePath: target.relativePath,
    name: posix.basename(target.relativePath),
    bytes: stat.size,
    modifiedAt: modifiedAt(stat),
    savedRevision: document.revision,
    contentHash: sha256(bytes),
    document
  }
}

function notebookSortKey(notebook: AnalysisNotebookSummary): string {
  const priority = notebook.relativePath.startsWith('notebooks/') ? '0' : '1'
  return `${priority}:${notebook.relativePath.toLocaleLowerCase()}`
}
class HostNotebookWorkspace implements NotebookWorkspace {
  constructor(
    readonly projectCwd: string,
    private readonly host: WorkspaceHost
  ) {}

  async list(options: NotebookDiscoveryOptions = {}): Promise<NotebookWorkspaceList> {
    const maxDepth = options.maxDepth ?? 8
    const maxEntries = options.maxEntries ?? 2_000
    const maxNotebooks = options.maxNotebooks ?? 200
    const notebooks: AnalysisNotebookSummary[] = []
    const state = { visited: 0, truncated: false }
    await this.visit('.', 0, { maxDepth, maxEntries, maxNotebooks }, notebooks, state)
    notebooks.sort((left, right) => notebookSortKey(left).localeCompare(notebookSortKey(right)))
    const initialized =
      (await isDirectory(this.host, 'notebooks')) && (await isDirectory(this.host, 'outputs'))
    return { notebooks, truncated: state.truncated, initialized }
  }

  async open(path: string): Promise<AnalysisNotebookFile> {
    const target = workspacePath(this.projectCwd, path)
    const bytes = await readNotebookBytes(this.host, target.relativePath)
    const stat = await this.host.fs.stat(target.relativePath, { includeModifiedAt: true })
    return notebookFile(target, bytes, stat)
  }

  async create(relativePath?: string): Promise<AnalysisNotebookFile> {
    const target = relativePath
      ? workspacePath(this.projectCwd, relativePath)
      : await this.uniqueNotebookPath()
    if (await pathExists(this.host, target.relativePath)) throw new Error('Notebook 已存在')
    await this.host.fs.mkdirp(posix.dirname(target.relativePath))
    const document = createEmptyNotebookDocument()
    await this.host.fs.writeAtomic(target.relativePath, serializeNotebookBytes(document))
    return this.open(target.relativePath)
  }

  async save(input: SaveProjectNotebookInput): Promise<AnalysisNotebookFile> {
    const target = workspacePath(this.projectCwd, input.path)
    let expectedHash: string | undefined
    const exists = await pathExists(this.host, target.relativePath)
    if (exists) {
      const current = await this.open(target.relativePath)
      if (
        (input.expectedRevision && current.savedRevision !== input.expectedRevision) ||
        (input.expectedHash && current.contentHash !== input.expectedHash)
      ) {
        throw notebookConflict()
      }
      expectedHash = input.expectedHash ?? current.contentHash
    } else if (input.expectedHash || input.expectedRevision) {
      throw notebookConflict()
    }
    await this.host.fs.mkdirp(posix.dirname(target.relativePath))
    try {
      const bytes = serializeNotebookBytes(input.document)
      await this.host.fs.writeAtomic(
        target.relativePath,
        bytes,
        expectedHash ? { expectedHash } : undefined
      )
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'HASH_MISMATCH') {
        throw notebookConflict()
      }
      throw error
    }
    return this.open(target.relativePath)
  }

  async close(path: string): Promise<{ path: string }> {
    return { path: (await this.open(path)).path }
  }

  async delete(path: string): Promise<DeleteProjectNotebookResult> {
    const file = await this.open(path)
    await this.host.fs.remove(file.relativePath)
    return { path: file.path, relativePath: file.relativePath }
  }

  async watch(
    path: string,
    listener: (event: NotebookWorkspaceWatchEvent) => void,
    options: { pollIntervalMs?: number } = {}
  ): Promise<NotebookWorkspaceWatchSubscription> {
    const file = await this.open(path)
    const target = workspacePath(this.projectCwd, file.relativePath)
    return watchHostNotebook({
      host: this.host,
      target,
      initial: file,
      listener,
      open: () => this.open(target.relativePath),
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    })
  }

  private async visit(
    directory: string,
    depth: number,
    limits: Required<NotebookDiscoveryOptions>,
    notebooks: AnalysisNotebookSummary[],
    state: { visited: number; truncated: boolean }
  ): Promise<void> {
    if (state.truncated || depth > limits.maxDepth) return
    let cursor: string | undefined
    do {
      let page
      try {
        page = await this.host.fs.list(directory, { cursor, limit: 1_000 })
      } catch (error) {
        if (directory !== '.' && isSkippableTraversalError(error)) return
        throw error
      }
      for (const entry of page.entries) {
        if (state.truncated) return
        state.visited += 1
        if (state.visited > limits.maxEntries || notebooks.length >= limits.maxNotebooks) {
          state.truncated = true
          return
        }
        await this.visitEntry(entry.path, entry.name, entry.kind, depth, limits, notebooks, state)
      }
      cursor = page.nextCursor
    } while (cursor)
  }

  private async visitEntry(
    path: string,
    name: string,
    kind: string,
    depth: number,
    limits: Required<NotebookDiscoveryOptions>,
    notebooks: AnalysisNotebookSummary[],
    state: { visited: number; truncated: boolean }
  ): Promise<void> {
    if (kind === 'directory') {
      if (!IGNORED_DIRECTORIES.has(name))
        await this.visit(path, depth + 1, limits, notebooks, state)
      return
    }
    if (kind !== 'file' || !name.toLocaleLowerCase().endsWith('.ipynb')) return
    let stat: WorkspaceStat
    try {
      stat = await this.host.fs.stat(path, { includeModifiedAt: true })
    } catch (error) {
      if (isSkippableTraversalError(error)) return
      throw error
    }
    if (stat.kind !== 'file') return
    const target = workspacePath(this.projectCwd, path)
    notebooks.push({
      path: target.path,
      relativePath: target.relativePath,
      name,
      directory:
        posix.dirname(target.relativePath) === '.' ? '' : posix.dirname(target.relativePath),
      bytes: stat.size,
      modifiedAt: modifiedAt(stat)
    })
  }

  private async uniqueNotebookPath(): Promise<WorkspacePath> {
    await this.host.fs.mkdirp('notebooks')
    for (let index = 1; ; index += 1) {
      const name = index === 1 ? 'Untitled.ipynb' : `Untitled ${index}.ipynb`
      const target = workspacePath(this.projectCwd, posix.join('notebooks', name))
      if (!(await pathExists(this.host, target.relativePath))) return target
    }
  }
}

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

export function createNotebookWorkspace(input: {
  projectCwd: string
  host: WorkspaceHost
}): NotebookWorkspace {
  return new HostNotebookWorkspace(input.projectCwd, input.host)
}

export function createLocalNotebookWorkspace(projectCwd: string): NotebookWorkspace {
  return createNotebookWorkspace({ projectCwd, host: new LocalHost(projectCwd) })
}
