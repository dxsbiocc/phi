import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

import { stringify as stringifyYaml } from 'yaml'

import { parseTarGz } from '../packages/archive'
import { assertSafePackagePath, sha256 } from '../packages/installer-utils'
import type { InstalledPackage, LocalRegistry } from '../packages/installer-types'
import { materializeRegistry } from '../packages/materialize-registry'
import type { PackageType } from '../packages/manifest'
import { readRegistry } from '../packages/registry'
import { readWrapperTreeState } from '../packages/wrapper-tree'
import { teamPackError } from './errors'

const PACKAGE_METADATA = new Set(['.source.json', 'files.json'])
const ALLOWED_TYPES: readonly PackageType[] = ['skill', 'plugin', 'wrapper', 'mcp']

export function materializeInstalledRegistry(options: {
  agentDir: string
  teamId: string
  installed: readonly InstalledPackage[]
  registryDir: string
  generatedAt: string
}): LocalRegistry {
  const sourcesRoot = join(dirname(options.registryDir), `.sources-${randomUUID()}`)
  mkdirSync(sourcesRoot, { recursive: true, mode: 0o700 })
  try {
    const packageDirs = options.installed.map((installed) => {
      const destination = join(sourcesRoot, `${installed.type}-${installed.id}`)
      if (installed.type === 'wrapper') {
        copyInstalledWrapper(options.agentDir, installed, destination)
      } else {
        copyPackageDirectory(installed.dir, destination)
      }
      return destination
    })
    materializeRegistry(packageDirs, options.registryDir, {
      id: `team-pack:${options.teamId}`,
      trust: 'imported',
      generatedAt: options.generatedAt,
      allowedTypes: ALLOWED_TYPES
    })
    return readRegistry(options.registryDir)
  } finally {
    rmSync(sourcesRoot, { recursive: true, force: true })
  }
}

export function materializeRegistryEntries(options: {
  teamId: string
  entries: Array<{ registry: LocalRegistry; entry: LocalRegistry['packages'][number] }>
  registryDir: string
  generatedAt: string
}): LocalRegistry {
  const sourcesRoot = join(dirname(options.registryDir), `.registry-entries-${randomUUID()}`)
  mkdirSync(sourcesRoot, { recursive: true, mode: 0o700 })
  try {
    const packageDirs = options.entries.map(({ registry, entry }) => {
      const archive = readFileSync(join(registry.dir, entry.archive))
      if (archive.length !== entry.size || sha256(archive) !== entry.sha256) {
        throw teamPackError('HASH_MISMATCH', `软件源资源哈希不匹配: ${entry.type}:${entry.id}`)
      }
      const destination = join(sourcesRoot, `${entry.type}-${entry.id}`)
      for (const item of parseTarGz(archive)) {
        const path = item.type === 'directory' ? item.path.replace(/\/+$/u, '') : item.path
        assertSafePackagePath(path)
        if (item.type === 'link' || (item.type !== 'file' && item.type !== 'directory')) {
          throw teamPackError('INVALID_FORMAT', '软件源资源归档包含不支持的条目')
        }
        const target = join(destination, ...path.split('/'))
        if (item.type === 'directory') mkdirSync(target, { recursive: true })
        else {
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, item.data, { flag: 'wx', mode: item.mode & 0o666 })
        }
      }
      return destination
    })
    materializeRegistry(packageDirs, options.registryDir, {
      id: `team-pack:${options.teamId}`,
      trust: 'imported',
      generatedAt: options.generatedAt,
      allowedTypes: ALLOWED_TYPES
    })
    return readRegistry(options.registryDir)
  } finally {
    rmSync(sourcesRoot, { recursive: true, force: true })
  }
}

function copyInstalledWrapper(
  agentDir: string,
  installed: InstalledPackage,
  destination: string
): void {
  assertSourceDirectory(installed.dir, '已安装 wrapper 目录')
  const state = readWrapperTreeState(agentDir).packages[installed.id]
  if (!state || state.version !== installed.version) {
    throw teamPackError(
      'INVALID_FORMAT',
      `找不到已安装 wrapper 的所有权记录: ${installed.id}@${installed.version}`
    )
  }
  mkdirSync(destination, { recursive: true })
  writeFileSync(join(destination, 'phi-package.yaml'), stringifyYaml(state.manifest), 'utf8')
  for (const ownedPath of state.paths) {
    copyRegularFile(
      join(installed.dir, ...ownedPath.split('/')),
      join(destination, ...ownedPath.split('/')),
      ownedPath
    )
  }
}

function copyPackageDirectory(sourceRoot: string, destinationRoot: string): void {
  assertSourceDirectory(sourceRoot, '已安装资源目录')
  const walk = (sourceDirectory: string): void => {
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      const source = join(sourceDirectory, entry.name)
      const relativePath = relative(sourceRoot, source)
      if (!relativePath.includes(sep) && PACKAGE_METADATA.has(relativePath)) continue
      const destination = join(destinationRoot, relativePath)
      const stat = lstatSync(source)
      if (stat.isSymbolicLink()) {
        throw teamPackError('INVALID_FORMAT', `已安装资源包含符号链接: ${relativePath}`)
      }
      if (stat.isDirectory()) {
        mkdirSync(destination, { recursive: true, mode: stat.mode & 0o777 })
        walk(source)
      } else if (stat.isFile()) {
        copyRegularFile(source, destination, relativePath)
      } else {
        throw teamPackError('INVALID_FORMAT', `已安装资源包含非普通文件: ${relativePath}`)
      }
    }
  }
  mkdirSync(destinationRoot, { recursive: true })
  walk(sourceRoot)
}

function assertSourceDirectory(path: string, label: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw teamPackError('INVALID_FORMAT', `${label}必须是非符号链接目录`)
  }
}

function copyRegularFile(source: string, destination: string, label: string): void {
  const stat = lstatSync(source)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw teamPackError('INVALID_FORMAT', `已安装资源包含非普通文件: ${label}`)
  }
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  chmodSync(destination, stat.mode & 0o777)
}
