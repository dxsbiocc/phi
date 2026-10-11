import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import semver from 'semver'

import type {
  WrapperPackageDetailView,
  WrapperPackageMember
} from '../../../shared/packageManagerTypes'
import { readModuleDetails, readWrapperDag } from '../wrappers/composition/module-files'
import { parseWrapperCompositionManifest } from '../wrappers/composition/manifest'
import { getPhiAgentDir } from '../runtime-paths'
import type { LocalRegistry, RegistryPackageEntry } from './installer-types'
import type { OfficialRegistryOptions } from './official-registry'
import { archiveFiles, readPackageArchive, type PackageFiles } from './package-archive'
import { getWrapperTreeDir, readWrapperTreeState } from './wrapper-tree'

const MANIFEST_SUFFIX = '/wrapper/wrapper.yaml'

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
    return summarize(entry, 'installed', installedFiles(agentDir, installed.paths))
  }
  return summarize(
    entry,
    'registry',
    archiveFiles(await readPackageArchive(registry, entry, options))
  )
}

function installedFiles(agentDir: string, paths: readonly string[]): PackageFiles {
  const root = resolve(getWrapperTreeDir(agentDir))
  return {
    paths,
    read: (path) => {
      const file = resolve(join(root, ...path.split('/')))
      if (!file.startsWith(root + sep)) return undefined
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return undefined
      }
    }
  }
}

function summarize(
  entry: RegistryPackageEntry,
  source: WrapperPackageDetailView['source'],
  files: PackageFiles
): WrapperPackageDetailView {
  const wrappers: WrapperPackageMember[] = []
  let skipped = 0
  for (const path of files.paths.filter((candidate) => candidate.endsWith(MANIFEST_SUFFIX))) {
    const wrapperDir = path.slice(0, -'/wrapper.yaml'.length)
    const componentDir = wrapperDir.slice(0, -'/wrapper'.length)
    const inDirectory = (directory: string) => (name: string) => files.read(`${directory}/${name}`)
    try {
      const manifest = parseWrapperCompositionManifest(files.read(path) ?? '')
      const dag = readWrapperDag(inDirectory(wrapperDir))
      const details = readModuleDetails(inDirectory(componentDir))
      wrappers.push({ ...manifest, ...(dag ? { dag } : {}), ...(details ? { details } : {}) })
    } catch {
      skipped += 1
    }
  }
  wrappers.sort((left, right) => left.id.localeCompare(right.id))
  return { id: entry.id, version: entry.version, source, wrappers, skipped }
}
