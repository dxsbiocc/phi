import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  posix,
  relative,
  resolve,
  sep
} from 'node:path'

import {
  WorkspaceHostError,
  type AtomicWriteOptions,
  type AtomicWriteResult,
  type GlobOptions,
  type ListOptions,
  type ListResult,
  type ReadRangeOptions,
  type ReadRangeResult,
  type RemoveOptions,
  type WorkspaceContent,
  type WorkspaceEntryKind,
  type WorkspaceHost,
  type WorkspaceStat
} from './types'

type FileSystemHost = WorkspaceHost['fs']

interface EntryType {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

function isInside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

function sha256(content: WorkspaceContent): string {
  return createHash('sha256').update(content).digest('hex')
}

function entryKind(entry: EntryType): WorkspaceEntryKind {
  if (entry.isFile()) return 'file'
  if (entry.isDirectory()) return 'directory'
  if (entry.isSymbolicLink()) return 'symlink'
  return 'other'
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function walkDirectory(
  directory: string,
  prefix: string,
  includeDirectories: boolean
): Promise<string[]> {
  const matches: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = prefix ? posix.join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) {
      if (includeDirectories) matches.push(path)
      matches.push(...(await walkDirectory(join(directory, entry.name), path, includeDirectories)))
    } else if (entry.isFile()) {
      matches.push(path)
    }
  }
  return matches
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

class LocalFileSystem {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  asHost(): FileSystemHost {
    return {
      glob: (pattern, options = {}) => this.glob(pattern, options),
      list: (path, options = {}) => this.list(path, options),
      mkdirp: (path) => this.mkdirp(path),
      readRange: (path, options) => this.readRange(path, options),
      remove: (path, options = {}) => this.remove(path, options),
      stat: (path) => this.stat(path),
      writeAtomic: (path, content, options = {}) => this.writeAtomic(path, content, options)
    }
  }

  private async candidate(path: string): Promise<{ root: string; target: string }> {
    const root = await realpath(this.root)
    const target = resolve(root, path)
    if (!isInside(root, target)) {
      throw new WorkspaceHostError('path is outside the workspace root', 'PATH_OUTSIDE_ROOT')
    }
    return { root, target }
  }

  private async existingPath(path: string): Promise<string> {
    const { root, target } = await this.candidate(path)
    const actual = await realpath(target)
    if (!isInside(root, actual)) {
      throw new WorkspaceHostError('path is outside the workspace root', 'PATH_OUTSIDE_ROOT')
    }
    return actual
  }

  private async entryPath(path: string): Promise<{ root: string; target: string }> {
    const resolved = await this.candidate(path)
    const parent =
      resolved.target === resolved.root ? resolved.root : await realpath(dirname(resolved.target))
    const actual = await realpath(resolved.target)
    if (!isInside(resolved.root, parent) || !isInside(resolved.root, actual)) {
      throw new WorkspaceHostError('path is outside the workspace root', 'PATH_OUTSIDE_ROOT')
    }
    return resolved
  }

  private async writePath(path: string): Promise<string> {
    const { root, target } = await this.candidate(path)
    const parent = await realpath(dirname(target))
    if (!isInside(root, parent)) {
      throw new WorkspaceHostError('path is outside the workspace root', 'PATH_OUTSIDE_ROOT')
    }
    try {
      const actual = await realpath(target)
      if (!isInside(root, actual)) {
        throw new WorkspaceHostError('path is outside the workspace root', 'PATH_OUTSIDE_ROOT')
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    return join(parent, basename(target))
  }

  private async readRange(path: string, options: ReadRangeOptions): Promise<ReadRangeResult> {
    if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
      throw new WorkspaceHostError(
        'range offset must be a non-negative integer',
        'INVALID_ARGUMENT'
      )
    }
    if (!Number.isSafeInteger(options.length) || options.length < 0) {
      throw new WorkspaceHostError(
        'range length must be a non-negative integer',
        'INVALID_ARGUMENT'
      )
    }
    const handle = await open(await this.existingPath(path), 'r')
    try {
      const info = await handle.stat()
      const buffer = Buffer.alloc(options.length)
      const { bytesRead } = await handle.read(buffer, 0, options.length, options.offset)
      return {
        content: buffer.subarray(0, bytesRead),
        bytesRead,
        eof: options.offset + bytesRead >= info.size
      }
    } finally {
      await handle.close()
    }
  }

  private async list(path: string, options: ListOptions): Promise<ListResult> {
    const limit = options.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new WorkspaceHostError('list limit must be between 1 and 1000', 'INVALID_ARGUMENT')
    }
    const root = await realpath(this.root)
    const target = await this.existingPath(path)
    const entries = (await readdir(target, { withFileTypes: true }))
      .map((entry) => ({
        name: entry.name,
        path: relative(root, join(target, entry.name)).split(sep).join('/'),
        kind: entryKind(entry)
      }))
      .sort((left, right) => compareNames(left.name, right.name))
    const cursor = options.cursor
    const start = cursor ? entries.findIndex((entry) => compareNames(entry.name, cursor) > 0) : 0
    const page = start < 0 ? [] : entries.slice(start, start + limit)
    const hasMore = start >= 0 && start + page.length < entries.length
    return { entries: page, ...(hasMore ? { nextCursor: page.at(-1)?.name } : {}) }
  }

  private async mkdirp(path: string): Promise<void> {
    const { root, target } = await this.candidate(path)
    let current = root
    for (const part of relative(root, target).split(sep).filter(Boolean)) {
      const candidate = join(current, part)
      await mkdir(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      const actual = await realpath(candidate)
      if (!isInside(root, actual) || !(await lstat(actual)).isDirectory()) {
        throw new WorkspaceHostError('path is outside the workspace root', 'PATH_OUTSIDE_ROOT')
      }
      current = actual
    }
  }

  private async remove(path: string, options: RemoveOptions): Promise<void> {
    const { root, target } = await this.entryPath(path)
    if (target === root) {
      throw new WorkspaceHostError('cannot remove the workspace root', 'INVALID_ARGUMENT')
    }
    await rm(target, { recursive: options.recursive ?? false, force: options.force ?? false })
  }

  private async stat(path: string): Promise<WorkspaceStat> {
    const { target } = await this.entryPath(path)
    const info = await lstat(target)
    return { kind: entryKind(info), size: info.size }
  }

  private async glob(pattern: string, options: GlobOptions): Promise<readonly string[]> {
    if (
      !pattern ||
      pattern.includes('\0') ||
      isAbsolute(pattern) ||
      posix.isAbsolute(pattern) ||
      pattern.split('/').includes('..')
    ) {
      throw new WorkspaceHostError(
        'glob pattern must stay inside the workspace',
        'INVALID_ARGUMENT'
      )
    }
    const cwd = await this.existingPath(options.cwd ?? '.')
    const paths = await walkDirectory(cwd, '', options.includeDirectories ?? false)
    return paths.filter((path) => matchesGlob(path, pattern)).sort()
  }

  private async writeAtomic(
    path: string,
    content: WorkspaceContent,
    options: AtomicWriteOptions
  ): Promise<AtomicWriteResult> {
    const target = await this.writePath(path)
    if (options.expectedHash !== undefined) {
      const current = await readFile(target).catch((error) => {
        if (errorCode(error) === 'ENOENT') return undefined
        throw error
      })
      if (current === undefined || sha256(current) !== options.expectedHash) {
        throw new WorkspaceHostError('file does not match the expected hash', 'HASH_MISMATCH')
      }
    }
    const temporary = join(dirname(target), `.phi-write-${randomUUID()}`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
      await handle.close()
      await rename(temporary, target)
    } catch (error) {
      await handle.close().catch(() => undefined)
      await rm(temporary, { force: true })
      throw error
    }
    return { hash: sha256(content) }
  }
}

export function createLocalFileSystem(root: string): FileSystemHost {
  return new LocalFileSystem(root).asHost()
}
