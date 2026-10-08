import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { assertSafePackagePath, sha256 } from './installer-utils'

export interface RegistryAsset {
  path: string
  sha256: string
  size: number
}

export function parseRegistryAsset(value: unknown, maxBytes: number): RegistryAsset {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid registry asset')
  }
  const asset = value as Record<string, unknown>
  if (
    typeof asset.path !== 'string' ||
    typeof asset.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    typeof asset.size !== 'number' ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1 ||
    asset.size > maxBytes
  )
    throw new Error('invalid registry asset checksum or size')
  assertSafeRegistryAssetPath(asset.path)
  return { path: asset.path, sha256: asset.sha256, size: asset.size }
}

export function assertSafeRegistryAssetPath(path: string): void {
  assertSafePackagePath(path)
  if (
    /[:%?#]/.test(path) ||
    [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error(`unsafe registry asset path: ${path}`)
  }
}

/** Walk from a trusted application root, refusing symlinks before any read/write. */
export function registryAssetPath(root: string, path: string, createParents = false): string {
  assertSafeRegistryAssetPath(path)
  const target = resolve(root, ...path.split('/'))
  safeRegistryDirectory(root, dirname(target), createParents)
  const stat = statIfPresent(target)
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`registry asset must be a regular file (no symlinks): ${path}`)
  }
  return target
}

export function safeRegistryDirectory(root: string, directory: string, create = false): void {
  const base = resolve(root)
  const target = resolve(directory)
  const suffix = relative(base, target)
  if (
    isAbsolute(suffix) ||
    suffix === '..' ||
    suffix.startsWith(`..${sep}`) ||
    resolve(base, suffix) !== target
  ) {
    throw new Error('registry directory escapes the managed root')
  }
  const paths = [base]
  for (const part of suffix.split(sep).filter(Boolean)) paths.push(resolve(paths.at(-1)!, part))
  for (const path of paths) {
    let stat = statIfPresent(path)
    if (!stat && create) {
      // Only the application root may need its trusted parent created by the caller.
      mkdirSync(path, { recursive: path === base })
      stat = lstatSync(path)
    }
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`registry directory is missing or a symbolic link: ${path}`)
    }
  }
}

export function readRegistryAsset(root: string, asset: RegistryAsset): Buffer {
  const path = registryAssetPath(root, asset.path)
  const stat = lstatSync(path)
  if (stat.size !== asset.size) throw new Error(`registry asset size mismatch: ${asset.path}`)
  const bytes = readFileSync(path)
  if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) {
    throw new Error(`registry asset checksum mismatch: ${asset.path}`)
  }
  return bytes
}

function statIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
