import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'

import type { RegistryIconAsset } from '../../../shared/resourceIconTypes'
import type { PackageType } from './manifest'

export const PACKAGE_ICON_FILENAMES = ['icon.svg', 'icon.png', 'icon.webp', 'icon.jpg', 'icon.jpeg']
const MAX_ICON_BYTES = 256 * 1024

/** Select only explicit package/family roots, never arbitrary nested images. */
export function findPackageIcon(
  files: ReadonlyMap<string, Buffer>,
  directories: readonly string[] = ['']
): string | undefined {
  for (const directory of directories) {
    for (const filename of PACKAGE_ICON_FILENAMES) {
      const path = directory ? `${directory}/${filename}` : filename
      if (files.has(path)) return path
    }
  }
  return undefined
}

export function writeRegistryIconAsset(
  entry: { type: PackageType; id: string; version: string },
  iconPath: string | undefined,
  files: ReadonlyMap<string, Buffer>,
  outDir: string
): RegistryIconAsset | undefined {
  if (!iconPath) return undefined
  const data = files.get(iconPath)
  if (!data || data.length === 0 || data.length > MAX_ICON_BYTES) {
    throw new Error(`package icon '${iconPath}' must contain 1–${MAX_ICON_BYTES} bytes`)
  }
  const path = `icons/${entry.type}-${entry.id}-${entry.version}${extname(iconPath)}`
  mkdirSync(join(outDir, 'icons'), { recursive: true })
  writeFileSync(join(outDir, path), data)
  return { path, sha256: createHash('sha256').update(data).digest('hex'), size: data.length }
}

export function parseRegistryIconAsset(value: unknown): RegistryIconAsset {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid registry iconAsset')
  }
  const asset = value as Record<string, unknown>
  if (
    typeof asset.path !== 'string' ||
    isAbsolute(asset.path) ||
    asset.path.includes('\\') ||
    /[:%?#]/.test(asset.path) ||
    [...asset.path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    asset.path.split('/').some((part) => !part || part === '.' || part === '..') ||
    !/\.(svg|png|webp|jpg|jpeg)$/.test(asset.path) ||
    typeof asset.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    typeof asset.size !== 'number' ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1 ||
    asset.size > MAX_ICON_BYTES
  ) {
    throw new Error('invalid registry iconAsset path, checksum, or size')
  }
  return { path: asset.path, sha256: asset.sha256, size: asset.size }
}
