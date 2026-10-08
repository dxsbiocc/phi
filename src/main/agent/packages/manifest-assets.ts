import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { RegistryPackageEntry } from './installer-types'
import { parsePackageManifestText, type PackageManifest } from './manifest'
import { sha256 } from './installer-utils'
import { parseRegistryAsset, readRegistryAsset, type RegistryAsset } from './registry-assets'

export const MAX_REGISTRY_MANIFEST_BYTES = 128 * 1024
export type RegistryManifestAsset = RegistryAsset

export function parseRegistryManifestAsset(value: unknown): RegistryManifestAsset {
  const asset = parseRegistryAsset(value, MAX_REGISTRY_MANIFEST_BYTES)
  if (!/\.(yaml|yml)$/.test(asset.path)) throw new Error('registry manifest asset must be YAML')
  return asset
}

export function readRegistryManifestAsset(
  registryDir: string,
  entry: RegistryPackageEntry
): PackageManifest | undefined {
  if (!entry.manifestAsset) return undefined
  const bytes = readRegistryAsset(registryDir, entry.manifestAsset)
  const manifest = parsePackageManifestText(bytes.toString('utf8'))
  if (
    manifest.type !== 'mcp' ||
    entry.type !== 'mcp' ||
    manifest.id !== entry.id ||
    manifest.version !== entry.version
  ) {
    throw new Error(
      `registry manifest identity mismatch: ${entry.type}:${entry.id}@${entry.version}`
    )
  }
  return manifest
}

export function writeRegistryManifestAsset(
  entry: { type: string; id: string; version: string },
  bytes: Buffer,
  outDir: string
): RegistryManifestAsset {
  if (bytes.length < 1 || bytes.length > MAX_REGISTRY_MANIFEST_BYTES) {
    throw new Error('registry manifest size exceeds the metadata limit')
  }
  const path = `manifests/${entry.type}-${entry.id}-${entry.version}.yaml`
  mkdirSync(join(outDir, 'manifests'), { recursive: true })
  writeFileSync(join(outDir, path), bytes)
  return { path, sha256: sha256(bytes), size: bytes.length }
}
