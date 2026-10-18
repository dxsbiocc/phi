import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

import { untilAbort } from './abort-wait'
import { publishRemoteSkillBundle, validateRemoteSkillBundle } from './skill-bundle-transport'
import type { RemoteRuntimeWorkspace, RemoteSkillBundleFile } from './types'

export type { RemoteSkillBundleFile } from './types'

const MAX_FILES = 2_000
const MAX_BYTES = 64 * 1024 * 1024
const bundleLocks = new Map<string, Promise<void>>()

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
  const files = collectRemoteSkillBundleFiles(skillDir)
  return prepareRemoteSkillBundleFiles(files, workspace, signal)
}

export async function prepareRemoteSkillBundleFiles(
  files: readonly RemoteSkillBundleFile[],
  workspace: RemoteRuntimeWorkspace,
  signal?: AbortSignal
): Promise<RemoteSkillBundle> {
  const checkedFiles = validateRemoteSkillBundleFiles(files)
  const hash = bundleHash(checkedFiles)
  const relativeDir = posix.join('skills', hash)
  const bundle = {
    hash,
    relativeDir,
    absoluteDir: posix.join(workspace.runtimeRoot, relativeDir),
    files: new Set(checkedFiles.map((file) => file.relativePath))
  }
  return withBundleLock(`${workspace.runtimeRoot}\0${hash}`, signal, async () => {
    const validation = await validateRemoteSkillBundle(workspace, bundle, checkedFiles, signal)
    if (validation.status === 'unsafe') {
      throw new Error('Remote Skill bundle destination contains an unsafe symlink')
    }
    if (validation.status === 'reusable') return bundle
    await publishRemoteSkillBundle(workspace, bundle, checkedFiles, signal)
    return bundle
  })
}

export function validateRemoteSkillBundleFiles(
  files: readonly RemoteSkillBundleFile[]
): RemoteSkillBundleFile[] {
  const checked: RemoteSkillBundleFile[] = []
  const paths = new Set<string>()
  let bytes = 0
  for (const file of files) {
    const parts = file.relativePath.split('/')
    if (
      !file.relativePath ||
      posix.isAbsolute(file.relativePath) ||
      file.relativePath.includes('\\') ||
      parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))
    ) {
      throw new Error(`Invalid Skill resource path: ${file.relativePath}`)
    }
    if (paths.has(file.relativePath)) {
      throw new Error(`Duplicate Skill resource path: ${file.relativePath}`)
    }
    if (!Buffer.isBuffer(file.content))
      throw new Error(`Invalid Skill resource content: ${file.relativePath}`)
    const content = Buffer.from(file.content)
    const contentHash = createHash('sha256').update(content).digest('hex')
    if (contentHash !== file.contentHash) {
      throw new Error(`Skill resource content hash mismatch: ${file.relativePath}`)
    }
    bytes += content.length
    if (checked.length >= MAX_FILES || bytes > MAX_BYTES) {
      throw new Error('Skill resources exceed the remote upload limit (2000 files or 64 MiB)')
    }
    paths.add(file.relativePath)
    checked.push({
      relativePath: file.relativePath,
      content,
      contentHash,
      executable: file.executable === true
    })
  }
  checked.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return checked
}

export function collectRemoteSkillBundleFiles(root: string): RemoteSkillBundleFile[] {
  const files: RemoteSkillBundleFile[] = []
  let bytes = 0
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink())
        throw new Error(`Skill resource contains an unsafe symlink: ${entry.name}`)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile())
        throw new Error(`Skill resource contains an unsupported file type: ${entry.name}`)
      const relativePath = remoteRelative(root, path)
      const content = readFileSync(path)
      bytes += content.length
      if (files.length >= MAX_FILES || bytes > MAX_BYTES) {
        throw new Error('Skill resources exceed the remote upload limit (2000 files or 64 MiB)')
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
    throw new Error('Invalid Skill resource path')
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
