import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

import type { WorkspaceHost } from '../workspace-host/types'
import { untilAbort } from './abort-wait'
import { assertSafeBundleDestination, removeRemoteSkillBundle } from './skill-bundle-destination'

const MAX_FILES = 2_000
const MAX_BYTES = 64 * 1024 * 1024
const DIRECT_TEXT_BYTES = 1024 * 1024
const UPLOAD_CHUNK_BYTES = 48 * 1024
const MARKER = '.phi-skill-bundle'
const bundleLocks = new Map<string, Promise<void>>()

interface BundleFile {
  relativePath: string
  content: Buffer
  executable: boolean
}

export interface RemoteSkillBundle {
  hash: string
  relativeDir: string
  absoluteDir: string
  files: ReadonlySet<string>
}

export async function prepareRemoteSkillBundle(
  skillDir: string,
  runtimeRoot: string,
  host: WorkspaceHost,
  signal?: AbortSignal
): Promise<RemoteSkillBundle> {
  const files = collectFiles(skillDir)
  const hash = bundleHash(files)
  const relativeDir = posix.join('skills', hash)
  const bundle = {
    hash,
    relativeDir,
    absoluteDir: posix.join(runtimeRoot, relativeDir),
    files: new Set(files.map((file) => file.relativePath))
  }
  return withBundleLock(`${runtimeRoot}\0${hash}`, signal, async () => {
    await assertSafeBundleDestination(host, bundle, signal)
    if (await reusable(host, bundle, files, signal)) return bundle
    await replaceBundle(host, bundle, files, signal)
    return bundle
  })
}

function collectFiles(root: string): BundleFile[] {
  const files: BundleFile[] = []
  let bytes = 0
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Skill 资源包含不安全的符号链接：${entry.name}`)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile()) throw new Error(`Skill 资源包含不支持的文件类型：${entry.name}`)
      const relativePath = remoteRelative(root, path)
      const content = readFileSync(path)
      bytes += content.length
      if (files.length >= MAX_FILES || bytes > MAX_BYTES) {
        throw new Error('Skill 资源超过远程上传上限（2000 个文件或 64 MiB）')
      }
      files.push({
        relativePath,
        content,
        executable: relativePath.startsWith('scripts/') || Boolean(lstatSync(path).mode & 0o111)
      })
    }
  }
  walk(root)
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return files
}

function remoteRelative(root: string, path: string): string {
  const value = relative(root, path)
  const parts = value.split(sep)
  if (
    !value ||
    parts.includes('..') ||
    parts.some((part) => !part || part.includes('\0') || part.includes('\\'))
  ) {
    throw new Error('Skill 资源路径无效')
  }
  return parts.join('/')
}

function bundleHash(files: readonly BundleFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.relativePath).update('\0')
    hash.update(file.executable ? '755' : '600').update('\0')
    hash.update(String(file.content.length)).update('\0')
    hash.update(file.content)
  }
  return hash.digest('hex')
}

async function reusable(
  host: WorkspaceHost,
  bundle: RemoteSkillBundle,
  files: readonly BundleFile[],
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const result = await host.fs.readRange(posix.join(bundle.relativeDir, MARKER), {
      offset: 0,
      length: 65
    })
    if (!result.eof || Buffer.from(result.content).toString('utf8').trim() !== bundle.hash) {
      return false
    }
    if (!(await exactFileSet(host, bundle, files))) return false
    for (const file of files) {
      signal?.throwIfAborted()
      if (!(await fileMatches(host, bundle, file))) return false
    }
    return permissionsReady(host, bundle, files, signal)
  } catch {
    return false
  }
}

async function exactFileSet(
  host: WorkspaceHost,
  bundle: RemoteSkillBundle,
  files: readonly BundleFile[]
): Promise<boolean> {
  const actual = await listBundleEntries(host, bundle.relativeDir)
  const expected = new Set([
    MARKER,
    ...files.map((file) => file.relativePath),
    ...nestedDirectories(files).map((directory) => `${directory}/`)
  ])
  return actual.length === expected.size && actual.every((path) => expected.has(path))
}

async function listBundleEntries(
  host: WorkspaceHost,
  directory: string,
  prefix = ''
): Promise<string[]> {
  const paths: string[] = []
  let cursor: string | undefined
  do {
    const page = await host.fs.list(directory, { limit: 1000, ...(cursor ? { cursor } : {}) })
    for (const entry of page.entries) {
      const path = prefix ? posix.join(prefix, entry.name) : entry.name
      if (entry.kind === 'directory') {
        paths.push(`${path}/`)
        paths.push(...(await listBundleEntries(host, posix.join(directory, entry.name), path)))
      } else paths.push(path)
    }
    cursor = page.nextCursor
  } while (cursor)
  return paths
}

async function fileMatches(
  host: WorkspaceHost,
  bundle: RemoteSkillBundle,
  file: BundleFile
): Promise<boolean> {
  const path = posix.join(bundle.relativeDir, file.relativePath)
  const stat = await host.fs.stat(path)
  if (stat.kind !== 'file' || stat.size !== file.content.length) return false
  const content = await host.fs.readRange(path, { offset: 0, length: file.content.length })
  return content.eof && Buffer.from(content.content).equals(file.content)
}

async function replaceBundle(
  host: WorkspaceHost,
  bundle: RemoteSkillBundle,
  files: readonly BundleFile[],
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  await assertSafeBundleDestination(host, bundle, signal)
  if (await exists(host, bundle.relativeDir)) {
    await removeRemoteSkillBundle(host, bundle, signal)
  }
  await assertSafeBundleDestination(host, bundle, signal)
  await host.fs.mkdirp(bundle.relativeDir)
  const directories = nestedDirectories(files)
  for (const directory of directories) {
    signal?.throwIfAborted()
    await host.fs.mkdirp(posix.join(bundle.relativeDir, directory))
  }
  for (const file of files) {
    signal?.throwIfAborted()
    await writeBundleFile(host, bundle, file, signal)
  }
  await applyPermissions(host, bundle, directories, files, signal)
  signal?.throwIfAborted()
  await host.fs.writeAtomic(posix.join(bundle.relativeDir, MARKER), `${bundle.hash}\n`)
}

function nestedDirectories(files: readonly BundleFile[]): string[] {
  const directories = new Set<string>()
  for (const file of files) {
    let current = posix.dirname(file.relativePath)
    while (current !== '.') {
      directories.add(current)
      current = posix.dirname(current)
    }
  }
  return [...directories].sort((left, right) => left.split('/').length - right.split('/').length)
}

async function writeBundleFile(
  host: WorkspaceHost,
  bundle: RemoteSkillBundle,
  file: BundleFile,
  signal?: AbortSignal
): Promise<void> {
  const relativePath = posix.join(bundle.relativeDir, file.relativePath)
  if (file.content.length <= DIRECT_TEXT_BYTES && isUtf8(file.content)) {
    await host.fs.writeAtomic(relativePath, file.content)
    return
  }
  await uploadBinary(host, posix.join(bundle.absoluteDir, file.relativePath), file.content, signal)
}

async function uploadBinary(
  host: WorkspaceHost,
  target: string,
  content: Buffer,
  signal?: AbortSignal
): Promise<void> {
  const temporary = `${target}.phi-upload-${randomUUID()}`
  await runUploadCommand(host, ['sh', '-c', 'umask 077; : > "$1"', 'phi-upload', temporary], signal)
  try {
    for (let offset = 0; offset < content.length; offset += UPLOAD_CHUNK_BYTES) {
      signal?.throwIfAborted()
      const encoded = content.subarray(offset, offset + UPLOAD_CHUNK_BYTES).toString('base64')
      await runUploadCommand(host, binaryAppendCommand(temporary, encoded), signal)
    }
    await runUploadCommand(host, ['mv', '-f', temporary, target], signal)
  } catch (error) {
    await runUploadCommand(host, ['rm', '-f', temporary], undefined).catch(() => undefined)
    throw error
  }
}

function binaryAppendCommand(path: string, encoded: string): [string, ...string[]] {
  const script = [
    'set -eu',
    'phi_chunk=$1.chunk',
    'if command -v base64 >/dev/null 2>&1; then',
    '  if ! printf %s "$2" | base64 -d > "$phi_chunk" 2>/dev/null; then',
    '    printf %s "$2" | base64 -D > "$phi_chunk"',
    '  fi',
    'elif command -v openssl >/dev/null 2>&1; then',
    '  printf %s "$2" | openssl base64 -d -A > "$phi_chunk"',
    'else exit 43; fi',
    'cat "$phi_chunk" >> "$1"',
    'rm -f "$phi_chunk"'
  ].join('\n')
  return ['sh', '-c', script, 'phi-upload', path, encoded]
}

async function runUploadCommand(
  host: WorkspaceHost,
  command: [string, ...string[]],
  signal?: AbortSignal
): Promise<void> {
  const result = await host.exec.run(command, {
    cwd: '.',
    signal,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024
  })
  if (result.code !== 0) throw new Error(`远程 Skill 二进制资源上传失败：${result.stderr.trim()}`)
}

async function applyPermissions(
  host: WorkspaceHost,
  bundle: RemoteSkillBundle,
  directories: readonly string[],
  files: readonly BundleFile[],
  signal?: AbortSignal
): Promise<void> {
  const directoryPaths = [
    bundle.absoluteDir,
    ...directories.map((path) => posix.join(bundle.absoluteDir, path))
  ]
  await chmod(host, '700', directoryPaths, signal)
  const scripts = files
    .filter((file) => file.executable)
    .map((file) => posix.join(bundle.absoluteDir, file.relativePath))
  await chmod(host, '755', scripts, signal)
}

async function chmod(
  host: WorkspaceHost,
  mode: string,
  paths: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  if (paths.length === 0) return
  const result = await host.exec.run(['chmod', mode, ...paths], {
    cwd: '.',
    signal,
    timeoutMs: 10_000,
    maxOutputBytes: 16 * 1024
  })
  if (result.code !== 0) throw new Error(`无法设置远程 Skill 权限：${result.stderr.trim()}`)
}

async function permissionsReady(
  host: WorkspaceHost,
  bundle: RemoteSkillBundle,
  files: readonly BundleFile[],
  signal?: AbortSignal
): Promise<boolean> {
  const directories = [
    bundle.absoluteDir,
    ...nestedDirectories(files).map((path) => posix.join(bundle.absoluteDir, path))
  ]
  const scripts = files
    .filter((file) => file.executable)
    .map((file) => posix.join(bundle.absoluteDir, file.relativePath))
  const script = [
    'phi_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }',
    'while [ "$1" != -- ]; do [ "$(phi_mode "$1")" = 700 ] || exit 1; shift; done',
    'shift',
    'for phi_path do [ "$(phi_mode "$phi_path")" = 755 ] || exit 1; done'
  ].join('\n')
  const result = await host.exec.run(
    ['sh', '-c', script, 'phi-check', ...directories, '--', ...scripts],
    {
      cwd: '.',
      signal,
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024
    }
  )
  return result.code === 0
}

function isUtf8(content: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content)
    return true
  } catch {
    return false
  }
}

async function exists(host: WorkspaceHost, path: string): Promise<boolean> {
  try {
    await host.fs.stat(path)
    return true
  } catch {
    return false
  }
}

async function withBundleLock<T>(
  key: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  const previous = bundleLocks.get(key) ?? Promise.resolve()
  let release = (): void => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => held)
  bundleLocks.set(key, tail)
  try {
    await untilAbort(previous, signal)
  } catch (error) {
    release()
    if (bundleLocks.get(key) === tail) bundleLocks.delete(key)
    throw error
  }
  try {
    signal?.throwIfAborted()
    return await operation()
  } finally {
    release()
    if (bundleLocks.get(key) === tail) bundleLocks.delete(key)
  }
}
