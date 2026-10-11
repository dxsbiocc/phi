import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import semver from 'semver'

import type { WrapperPackageDetailView } from '../../../shared/packageManagerTypes'
import type { WrapperCompositionManifest } from '../../../shared/wrapperCompositionManifestTypes'
import { parseWrapperCompositionManifest } from '../wrappers/composition/manifest'
import { getPhiAgentDir } from '../runtime-paths'
import { parseTarGz } from './archive'
import type { LocalRegistry, RegistryPackageEntry } from './installer-types'
import {
  isOfficialRegistryDirectory,
  readOfficialPackageArchive,
  type OfficialRegistryOptions
} from './official-registry'
import { readRegistryAsset } from './registry-assets'
import { getWrapperTreeDir, readWrapperTreeState } from './wrapper-tree'

const MANIFEST_SUFFIX = '/wrapper/wrapper.yaml'

interface ManifestSource {
  path: string
  read: () => string
}

/**
 * List the wrappers a package contains so the catalog can show them before installation.
 * An installed package is read from the local tree; otherwise only the selected package
 * archive is fetched, verified against the signed index, and cached.
 */
export async function readWrapperPackageDetail(
  registry: LocalRegistry,
  id: string,
  options: OfficialRegistryOptions = {}
): Promise<WrapperPackageDetailView> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const entry = registry.packages
    .filter((candidate) => candidate.type === 'wrapper' && candidate.id === id)
    .sort((left, right) => semver.rcompare(left.version, right.version))[0]
  if (!entry) throw new Error(`注册表中找不到 wrapper 软件包 ${id}`)

  const installed = readWrapperTreeState(agentDir).packages[id]
  if (installed && installed.version === entry.version) {
    return summarize(entry, 'installed', installedSources(agentDir, installed.paths))
  }
  const archive = await readArchive(registry, entry, options)
  const sources = parseTarGz(archive)
    .filter((file) => file.type === 'file' && file.path.endsWith(MANIFEST_SUFFIX))
    .map<ManifestSource>((file) => ({ path: file.path, read: () => file.data.toString('utf8') }))
  return summarize(entry, 'registry', sources)
}

function readArchive(
  registry: LocalRegistry,
  entry: RegistryPackageEntry,
  options: OfficialRegistryOptions
): Promise<Buffer> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  if (isOfficialRegistryDirectory(registry.dir, agentDir)) {
    return readOfficialPackageArchive(registry, entry, options)
  }
  return Promise.resolve(
    readRegistryAsset(registry.dir, {
      path: entry.archive,
      sha256: entry.sha256,
      size: entry.size
    })
  )
}

function installedSources(agentDir: string, paths: readonly string[]): ManifestSource[] {
  const root = resolve(getWrapperTreeDir(agentDir))
  return paths
    .filter((path) => path.endsWith(MANIFEST_SUFFIX))
    .map((path) => ({
      path,
      read: () => {
        const file = resolve(join(root, ...path.split('/')))
        if (!file.startsWith(root + sep)) throw new Error(`wrapper path escapes the tree: ${path}`)
        return readFileSync(file, 'utf8')
      }
    }))
}

function summarize(
  entry: RegistryPackageEntry,
  source: WrapperPackageDetailView['source'],
  sources: readonly ManifestSource[]
): WrapperPackageDetailView {
  const wrappers: WrapperCompositionManifest[] = []
  let skipped = 0
  for (const item of [...sources].sort((left, right) => left.path.localeCompare(right.path))) {
    try {
      wrappers.push(parseWrapperCompositionManifest(item.read()))
    } catch {
      skipped += 1
    }
  }
  wrappers.sort((left, right) => left.id.localeCompare(right.id))
  return { id: entry.id, version: entry.version, source, wrappers, skipped }
}
