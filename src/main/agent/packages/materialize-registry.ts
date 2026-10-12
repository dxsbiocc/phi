import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { createDeterministicTarGz, type ArchiveFile } from './archive'
import type { LocalRegistry, RegistryPackageEntry, RegistryTrustTier } from './installer-types'
import { sha256 } from './installer-utils'
import { writeRegistryManifestAsset } from './manifest-assets'
import { validatePackage } from './manifest'

export interface MaterializeRegistryOptions {
  id: string
  trust?: RegistryTrustTier
  generatedAt?: string
}

export function materializeRegistry(
  packageDirs: readonly string[],
  outDir: string,
  options: MaterializeRegistryOptions
): LocalRegistry {
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error(`软件源生成时间无效: ${generatedAt}`)
  }
  mkdirSync(outDir, { recursive: true })

  const ids = new Set<string>()
  const packages = packageDirs.map((packageDir) => {
    const validation = validatePackage(packageDir)
    if (!validation.ok || !validation.package) {
      throw new Error(
        `MCP 软件包无效: ${packageDir}（${validation.errors
          .map((problem) => `${problem.path}: ${problem.message}`)
          .join('；')}）`
      )
    }
    const manifest = validation.package.manifest
    if (manifest.type !== 'mcp') throw new Error(`连接器源不是 MCP 软件包: ${packageDir}`)
    if (ids.has(manifest.id)) throw new Error(`软件源包含重复软件包: ${manifest.id}`)
    ids.add(manifest.id)

    const files = regularPackageFiles(packageDir)
    const fileList = files.map(({ path, data }) => ({
      path,
      sha256: sha256(data),
      size: data.length
    }))
    const filesJson = Buffer.from(`${JSON.stringify({ version: 1, files: fileList }, null, 2)}\n`)
    const archive = createDeterministicTarGz([...files, { path: 'files.json', data: filesJson }])
    const archiveName = `mcp-${manifest.id}-${manifest.version}.tar.gz`
    writeFileSync(join(outDir, archiveName), archive)

    const entry: RegistryPackageEntry = {
      id: manifest.id,
      type: 'mcp',
      version: manifest.version,
      title: manifest.title,
      summary: manifest.summary,
      archive: archiveName,
      sha256: sha256(archive),
      size: archive.length,
      dependsOn: manifest.dependsOn ?? [],
      ...(manifest.minAppVersion ? { minAppVersion: manifest.minAppVersion } : {}),
      ...(manifest.requires ? { requires: manifest.requires } : {})
    }
    entry.manifestAsset = writeRegistryManifestAsset(
      entry,
      readFileSync(join(packageDir, 'phi-package.yaml')),
      outDir
    )
    return entry
  })
  packages.sort((left, right) =>
    left.id === right.id
      ? left.version.localeCompare(right.version)
      : left.id.localeCompare(right.id)
  )

  const index = { schemaVersion: 1 as const, generatedAt, packages }
  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  return {
    id: options.id,
    dir: outDir,
    trust: options.trust ?? 'imported',
    ...index
  }
}

export function materializeConnectorRegistry(
  packageDir: string,
  outDir: string,
  registryId: string,
  trust: RegistryTrustTier
): LocalRegistry {
  return materializeRegistry([packageDir], outDir, {
    id: registryId,
    trust,
    generatedAt: new Date(0).toISOString()
  })
}

export function regularPackageFiles(root: string): ArchiveFile[] {
  const files: ArchiveFile[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const stat = lstatSync(path)
      const relativePath = relative(root, path).split('\\').join('/')
      if (stat.isSymbolicLink()) throw new Error(`连接器软件包不允许符号链接: ${relativePath}`)
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile() && relativePath !== 'files.json') {
        files.push({ path: relativePath, data: readFileSync(path), mode: stat.mode & 0o777 })
      } else if (!stat.isFile()) {
        throw new Error(`连接器软件包包含非普通文件: ${relativePath}`)
      }
    }
  }
  walk(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}
