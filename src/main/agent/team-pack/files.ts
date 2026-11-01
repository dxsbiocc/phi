import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path'

import type { ArchiveFile, TarEntry } from '../packages/archive'
import { teamPackError } from './errors'

export function collectArchiveFiles(root: string, prefix: string): ArchiveFile[] {
  const output: ArchiveFile[] = []
  collect(root, prefix, output)
  return output
}

export function writeAtomic(path: string, data: Buffer, mode = 0o644): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, data, { flag: 'wx', mode })
    chmodSync(temporary, mode)
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Best-effort cleanup.
    }
    throw error
  }
}

export function extractRegistryEntries(entries: TarEntry[], destination: string): Buffer {
  const seen = new Set<string>()
  let inner: Buffer | undefined
  for (const entry of entries) {
    assertSafeArchiveEntry(entry.path)
    if (seen.has(entry.path)) {
      throw teamPackError('INVALID_FORMAT', '团队包归档包含重复路径')
    }
    seen.add(entry.path)
    if (entry.type !== 'file') {
      throw teamPackError('INVALID_FORMAT', '团队包归档只允许普通文件')
    }
    if (entry.path === 'inner.json') {
      inner = entry.data
      continue
    }
    if (!entry.path.startsWith('registry/')) {
      throw teamPackError('INVALID_FORMAT', '团队包归档包含未知路径')
    }
    const relative = entry.path.slice('registry/'.length)
    assertSafeArchiveEntry(relative)
    const target = join(destination, ...relative.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data, { mode: entry.mode & 0o666 })
  }
  if (!inner) throw teamPackError('INVALID_FORMAT', '团队包归档缺少 inner.json')
  if (!seen.has('registry/index.json')) {
    throw teamPackError('INVALID_FORMAT', '团队包归档缺少 registry/index.json')
  }
  return inner
}

export function assertSafeArchiveEntry(path: string): void {
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    posix.normalize(path) !== path
  ) {
    throw teamPackError('INVALID_FORMAT', '团队包归档包含不安全路径')
  }
}

export function assertManagedDirectory(path: string, label: string): void {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw teamPackError('INVALID_FORMAT', `${label} 必须是非符号链接目录`)
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    if (error instanceof Error && 'code' in error && error.code === 'INVALID_FORMAT') throw error
    throw teamPackError('STORE_UNAVAILABLE', `无法检查${label}`, error)
  }
}

export function assertManagedFile(path: string, label: string): void {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw teamPackError('INVALID_FORMAT', `${label} 必须是普通文件`)
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    if (error instanceof Error && 'code' in error && error.code === 'INVALID_FORMAT') throw error
    throw teamPackError('STORE_UNAVAILABLE', `无法检查${label}`, error)
  }
}

export function assertManagedChildDirectory(root: string, child: string, label: string): void {
  assertManagedDirectory(root, '管理根目录')
  assertManagedDirectory(child, label)
  try {
    const rootPath = realpathSync(root)
    const childPath = realpathSync(child)
    const suffix = relative(rootPath, childPath)
    if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
      throw teamPackError('INVALID_FORMAT', `${label} 越过管理根目录`)
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    if (error instanceof Error && 'code' in error && error.code === 'INVALID_FORMAT') throw error
    throw teamPackError('STORE_UNAVAILABLE', `无法检查${label}`, error)
  }
}

function collect(directory: string, prefix: string, output: ArchiveFile[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const source = join(directory, entry.name)
    const archivePath = posix.join(prefix, entry.name)
    if (entry.isDirectory()) {
      collect(source, archivePath, output)
      continue
    }
    const stat = lstatSync(source)
    if (!entry.isFile() || stat.isSymbolicLink()) {
      throw teamPackError('INVALID_FORMAT', '软件源只能包含普通文件和目录')
    }
    output.push({ path: archivePath, data: readFileSync(source), mode: stat.mode & 0o666 })
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}
