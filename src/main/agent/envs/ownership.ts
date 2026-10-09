import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** Reject redirected ancestors before reading or deleting a runtime-owned tree. */
export function ownedRuntimeDirectory(root: string, ...segments: string[]): string {
  if (segments.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(part))) {
    throw new Error('环境路径不是受管目录，已拒绝清理')
  }
  let canonicalRoot = resolve(root)
  try {
    canonicalRoot = realpathSync(canonicalRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let directory = canonicalRoot
  for (const part of segments) {
    directory = join(directory, part)
    try {
      const stat = lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('环境清理路径包含非受管目录或符号链接')
      }
      if (realpathSync(directory) !== directory) {
        throw new Error('环境清理路径解析到受管目录之外')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return directory
}

/** Persisted registry paths never grant deletion authority outside the owned runtime. */
export function ownedEnvironmentPrefix(root: string, envId: string, prefix: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(envId) || !isAbsolute(prefix)) {
    throw new Error('环境路径不是受管目录，已拒绝清理')
  }
  const lexicalRoot = resolve(root)
  const canonicalRoot = realpathSync(lexicalRoot)
  const expected = join(canonicalRoot, 'envs', envId)
  const actual = resolve(prefix)
  if (actual !== expected && actual !== join(lexicalRoot, 'envs', envId)) {
    throw new Error('环境记录指向受管目录之外，已拒绝清理')
  }
  return ownedRuntimeDirectory(root, 'envs', envId)
}
