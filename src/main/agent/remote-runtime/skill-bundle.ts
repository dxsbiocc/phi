import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

import { untilAbort } from './abort-wait'
import { publishRemoteSkillBundle, validateRemoteSkillBundle } from './skill-bundle-transport'
import type { RemoteRuntimeWorkspace } from './types'

const MAX_FILES = 2_000
const MAX_BYTES = 64 * 1024 * 1024
const bundleLocks = new Map<string, Promise<void>>()

export interface RemoteSkillBundleFile {
  relativePath: string
  content: Buffer
  contentHash: string
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
  workspace: RemoteRuntimeWorkspace,
  signal?: AbortSignal
): Promise<RemoteSkillBundle> {
  const files = collectFiles(skillDir)
  const hash = bundleHash(files)
  const relativeDir = posix.join('skills', hash)
  const bundle = {
    hash,
    relativeDir,
    absoluteDir: posix.join(workspace.runtimeRoot, relativeDir),
    files: new Set(files.map((file) => file.relativePath))
  }
  return withBundleLock(`${workspace.runtimeRoot}\0${hash}`, signal, async () => {
    const validation = await validateRemoteSkillBundle(workspace, bundle, files, signal)
    if (validation.status === 'unsafe') {
      throw new Error('远程 Skill bundle 目标包含不安全的符号链接')
    }
    if (validation.status === 'reusable') return bundle
    await publishRemoteSkillBundle(workspace, bundle, files, signal)
    return bundle
  })
}

function collectFiles(root: string): RemoteSkillBundleFile[] {
  const files: RemoteSkillBundleFile[] = []
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
        contentHash: createHash('sha256').update(content).digest('hex'),
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

function bundleHash(files: readonly RemoteSkillBundleFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.relativePath).update('\0')
    hash.update(file.executable ? '755' : '600').update('\0')
    hash.update(String(file.content.length)).update('\0')
    hash.update(file.content)
  }
  return hash.digest('hex')
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
