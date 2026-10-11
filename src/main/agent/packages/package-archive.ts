import { parseTarGz } from './archive'
import { getPhiAgentDir } from '../runtime-paths'
import type { LocalRegistry, RegistryPackageEntry } from './installer-types'
import {
  isOfficialRegistryDirectory,
  readOfficialPackageArchive,
  type OfficialRegistryOptions
} from './official-registry'
import { readRegistryAsset } from './registry-assets'

/** The files of one package, from the installed tree or a verified archive. */
export interface PackageFiles {
  paths: readonly string[]
  /** `undefined` when the file is missing or cannot be read. */
  read: (path: string) => string | undefined
}

/**
 * The verified archive bytes of one package: fetched on demand and cached for the official
 * source, read from the directory for a local one.
 */
export function readPackageArchive(
  registry: LocalRegistry,
  entry: RegistryPackageEntry,
  options: OfficialRegistryOptions = {}
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

export function archiveFiles(archive: Buffer): PackageFiles {
  const files = new Map(
    parseTarGz(archive)
      .filter((file) => file.type === 'file')
      .map((file) => [file.path, file.data] as const)
  )
  return {
    paths: [...files.keys()],
    read: (path) => files.get(path)?.toString('utf8')
  }
}
