import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import semver from 'semver'

import type { FeaturedMcpConnector } from '../../shared/mcpConnectorCatalog'
import type { EnvironmentBuildStartOptions } from './content/environment-builds'
import type { EnvironmentDescriptor } from './content/environment-refs'
import { createDeterministicTarGz, parseTarGz, type ArchiveFile } from './packages/archive'
import {
  installPackages,
  listInstalledPackages,
  planInstall,
  readRegistry,
  uninstallPackage
} from './packages/installer'
import type {
  InstalledPackage,
  InstallerOptions,
  LocalRegistry,
  RegistryPackageEntry
} from './packages/installer-types'
import {
  parsePackageManifestText,
  readPackageManifest,
  validatePackage,
  type McpPackageManifest
} from './packages/manifest'
import { localArchivePath, sha256 } from './packages/installer-utils'
import { getBundledResourceDir } from './runtime/runtime-adapter'
import { getPhiAgentDir } from './runtime-paths'
import {
  MCP_PACKAGE_MARKER_FIELD,
  packageIdFromMcpEntry,
  readMcpConfig,
  refreshPersistedManagedStdioServers,
  setMcpPackageConfigEnabled,
  writeMcpConfig,
  type McpPackageConfigOptions
} from './mcp/package-config'
import {
  describeMcpPackageEnvironment,
  type McpEnvironmentLookupOptions
} from './mcp/package-environment'
import { readManagedMarker } from './mcp/stdio-environment'

export { MCP_PACKAGE_MARKER_FIELD, refreshPersistedManagedStdioServers }

export interface ConnectorCatalogOptions extends McpPackageConfigOptions {
  /** Optional built registry containing bundled connectors; source manifests are used by default. */
  bundledRegistryDir?: string
  /** Bundled connector source root override used by isolated runtimes and tests. */
  bundledConnectorsDir?: string
  /** Local registries remembered by the caller. */
  registryDirs?: readonly string[]
  appVersion?: string
}

export interface ConnectorEnvironmentBuildAction {
  descriptor: EnvironmentDescriptor
  options: EnvironmentBuildStartOptions
}

interface CatalogSource {
  manifest: McpPackageManifest
  registryDir: string
}

export function getBundledConnectorsDir(): string {
  return getBundledResourceDir('connectors')
}

/** Catalog data from shipped source packages and each local registry known by the caller. */
export function listConnectorCatalog(
  options: ConnectorCatalogOptions = {}
): FeaturedMcpConnector[] {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const appVersion = options.appVersion ?? readAppVersion()
  if (!semver.valid(appVersion)) throw new Error(`应用版本无效: ${appVersion}`)
  const config = readMcpConfig(agentDir)
  const servers = config.mcpServers ?? {}
  const sources: CatalogSource[] = []

  if (options.bundledRegistryDir) {
    sources.push(...catalogSourcesFromRegistry(options.bundledRegistryDir))
  } else {
    sources.push(
      ...catalogSourcesFromDirectory(options.bundledConnectorsDir ?? getBundledConnectorsDir())
    )
  }
  for (const dir of uniquePaths(options.registryDirs ?? [])) {
    if (options.bundledRegistryDir && resolve(dir) === resolve(options.bundledRegistryDir)) continue
    sources.push(...catalogSourcesFromRegistry(dir))
  }

  const selected = new Map<string, CatalogSource>()
  for (const source of sources) {
    const current = selected.get(source.manifest.id)
    if (!current || semver.gt(source.manifest.version, current.manifest.version)) {
      selected.set(source.manifest.id, source)
    }
  }

  return [...selected.values()]
    .map(({ manifest, registryDir }) => {
      const connector = manifest.connector
      const entry = servers[manifest.id]
      const marker = readManagedMarker(entry)
      const unavailableReason =
        manifest.minAppVersion && semver.lt(appVersion, manifest.minAppVersion)
          ? `需要 Phi ${manifest.minAppVersion} 或更高版本`
          : undefined
      const result: FeaturedMcpConnector = {
        id: manifest.id,
        version: manifest.version,
        name: manifest.title,
        description: manifest.summary,
        publisher: connector.publisher,
        category: connector.category,
        signIn:
          connector.transport === 'http'
            ? connector.auth === 'none'
              ? '无需登录'
              : connector.auth === 'header'
                ? '需要凭据'
                : '需要登录'
            : '本地服务',
        transport: connector.transport,
        homepageUrl: connector.homepage,
        minAppVersion: manifest.minAppVersion,
        registryDir,
        added: entry !== undefined,
        unavailableReason
      }
      if (connector.transport === 'http') {
        result.auth = connector.auth
        result.url = connector.url
      } else {
        result.environment = connector.environment
        result.command = connector.command
        result.args = [...(connector.args ?? [])]
        if (entry !== undefined) result.environmentState = marker?.pending ? 'not-built' : 'ready'
      }
      return result
    })
    .sort(
      (left, right) =>
        left.category.localeCompare(right.category) || left.name.localeCompare(right.name)
    )
}

/** Installs or upgrades a connector from a built registry or the shipped source tree. */
export async function installCatalogConnector(
  registryDir: string,
  id: string,
  version?: string,
  options: InstallerOptions = {}
): Promise<InstalledPackage[]> {
  const source = resolve(registryDir)
  if (isRegistryDirectory(source)) {
    const registry = readRegistry(source)
    return installConnectorFromRegistry(registry, id, version, options)
  }

  const packageDir = connectorSourceDir(source, id)
  const manifest = readPackageManifest(packageDir)
  if (manifest.type !== 'mcp' || manifest.id !== id) {
    throw new Error(`连接器源与请求不匹配: mcp:${id}`)
  }
  if (version && manifest.version !== version) {
    throw new Error(`连接器 ${id} 没有版本 ${version}`)
  }
  const temporary = mkdtempSync(join(tmpdir(), 'phi-connector-registry-'))
  try {
    const registry = materializeConnectorRegistry(packageDir, temporary, source)
    return await installConnectorFromRegistry(registry, id, version, options)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function uninstallCatalogConnector(
  id: string,
  options: InstallerOptions = {}
): InstalledPackage[] {
  return uninstallPackage('mcp', id, options)
}

export function connectorEnvironmentBuildAction(
  id: string,
  options: McpEnvironmentLookupOptions & { agentDir?: string } = {}
): ConnectorEnvironmentBuildAction {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const installed = listInstalledPackages({ agentDir }).find(
    (entry) => entry.type === 'mcp' && entry.id === id
  )
  if (!installed) throw new Error(`MCP 软件包 ${id} 尚未安装`)
  const manifest = readPackageManifest(installed.dir)
  if (manifest.type !== 'mcp') throw new Error(`MCP 软件包 ${id} 清单类型无效`)
  const environment = describeMcpPackageEnvironment(manifest, installed.dir, {
    agentDir,
    environmentsDir: options.environmentsDir,
    platform: options.platform
  })
  if (!environment) throw new Error(`HTTP 连接器 ${id} 没有可构建的环境`)
  return {
    descriptor: environment.descriptor,
    options: {
      ref: environment.descriptor.ref,
      requestedBy: { mcp: id }
    }
  }
}

export function setMcpPackageEnabled(
  id: string,
  enabled: boolean,
  agentDir = getPhiAgentDir()
): boolean {
  return setMcpPackageConfigEnabled(id, enabled, agentDir)
}

export function addRemoteMcpConnector(
  name: string,
  url: string,
  agentDir = getPhiAgentDir()
): void {
  const validatedName = validateName(name)
  const validatedUrl = validateUrl(url)
  const config = readMcpConfig(agentDir)
  const servers = config.mcpServers ?? {}
  const existing = servers[validatedName]
  if (existing !== undefined) {
    if (isRecord(existing) && existing.url === validatedUrl) return
    throw new Error(`已有名为 ${validatedName} 的 MCP 配置`)
  }
  writeMcpConfig(
    {
      ...config,
      mcpServers: {
        ...servers,
        [validatedName]: { type: 'http', url: validatedUrl, enabled: true }
      }
    },
    agentDir
  )
}

export function removeRemoteMcpConnector(
  name: string,
  url: string,
  agentDir = getPhiAgentDir()
): void {
  const validatedName = validateName(name)
  const validatedUrl = validateUrl(url)
  const config = readMcpConfig(agentDir)
  const servers = config.mcpServers ?? {}
  const existing = servers[validatedName]
  if (
    !isRecord(existing) ||
    existing.url !== validatedUrl ||
    packageIdFromMcpEntry(existing) !== undefined
  ) {
    throw new Error('连接器配置已变化，请刷新后重试')
  }
  const remaining = { ...servers }
  delete remaining[validatedName]
  writeMcpConfig({ ...config, mcpServers: remaining }, agentDir)
}

function installConnectorFromRegistry(
  registry: LocalRegistry,
  id: string,
  version: string | undefined,
  options: InstallerOptions
): Promise<InstalledPackage[]> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const installed = listInstalledPackages({ agentDir }).find(
    (entry) => entry.type === 'mcp' && entry.id === id
  )
  const request = { type: 'mcp' as const, id, ...(version ? { version } : {}) }
  if (installed) {
    const candidate = registry.packages
      .filter((entry) => entry.type === 'mcp' && entry.id === id)
      .filter((entry) => !version || entry.version === version)
      .sort((left, right) => semver.rcompare(left.version, right.version))[0]
    if (!candidate) throw new Error(`注册表中找不到软件包 mcp:${id}`)
    if (!semver.gt(candidate.version, installed.version)) {
      throw new Error(`升级版本必须高于 ${installed.version}，收到 ${candidate.version}`)
    }
  }
  const plan = planInstall(registry, request, {
    agentDir,
    ...(options.appVersion ? { appVersion: options.appVersion } : {})
  })
  return installPackages(plan, { ...options, agentDir })
}

function catalogSourcesFromDirectory(root: string): CatalogSource[] {
  const directory = resolve(root)
  const candidates = isPackageDirectory(directory)
    ? [directory]
    : readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(directory, entry.name))
        .filter(isPackageDirectory)
  return candidates.map((dir) => {
    const validation = validatePackage(dir)
    if (!validation.ok || validation.package?.manifest.type !== 'mcp') {
      throw new Error(
        `连接器软件包无效 ${dir}: ${validation.errors
          .map((problem) => `${problem.path}: ${problem.message}`)
          .join('; ')}`
      )
    }
    return { manifest: validation.package.manifest, registryDir: directory }
  })
}

function catalogSourcesFromRegistry(dir: string): CatalogSource[] {
  const registry = readRegistry(dir)
  return registry.packages
    .filter((entry) => entry.type === 'mcp')
    .map((entry) => ({
      manifest: manifestFromRegistryEntry(registry, entry),
      registryDir: registry.dir
    }))
}

function manifestFromRegistryEntry(
  registry: LocalRegistry,
  entry: RegistryPackageEntry
): McpPackageManifest {
  const archive = readFileSync(localArchivePath(registry, entry.archive))
  if (archive.length !== entry.size || sha256(archive) !== entry.sha256) {
    throw new Error(`MCP 软件包归档校验失败: ${entry.id}@${entry.version}`)
  }
  const manifestFile = parseTarGz(archive).find(
    (item) => item.type === 'file' && item.path === 'phi-package.yaml'
  )
  if (!manifestFile) throw new Error(`MCP 软件包 ${entry.id} 缺少 phi-package.yaml`)
  const manifest = parsePackageManifestText(manifestFile.data.toString('utf8'))
  if (manifest.type !== 'mcp' || manifest.id !== entry.id || manifest.version !== entry.version) {
    throw new Error(`MCP 软件包清单与注册表不匹配: ${entry.id}@${entry.version}`)
  }
  return manifest
}

function materializeConnectorRegistry(
  packageDir: string,
  outDir: string,
  registryId: string
): LocalRegistry {
  const manifest = readPackageManifest(packageDir)
  if (manifest.type !== 'mcp') throw new Error(`连接器源不是 MCP 软件包: ${packageDir}`)
  const files = regularPackageFiles(packageDir)
  const fileList = files.map(({ path, data }) => ({
    path,
    sha256: sha256(data),
    size: data.length
  }))
  const filesJson = Buffer.from(`${JSON.stringify({ version: 1, files: fileList }, null, 2)}\n`)
  const archive = createDeterministicTarGz([...files, { path: 'files.json', data: filesJson }])
  const archiveName = `mcp-${manifest.id}-${manifest.version}.tar.gz`
  mkdirSync(outDir, { recursive: true })
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
  return {
    id: registryId,
    dir: outDir,
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    packages: [entry]
  }
}

function regularPackageFiles(root: string): ArchiveFile[] {
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

function connectorSourceDir(source: string, id: string): string {
  const direct = isPackageDirectory(source) ? source : join(source, id)
  if (!isPackageDirectory(direct)) throw new Error(`连接器源不存在: ${id}`)
  return direct
}

function isPackageDirectory(dir: string): boolean {
  try {
    return lstatSync(join(dir, 'phi-package.yaml')).isFile()
  } catch {
    return false
  }
}

function isRegistryDirectory(dir: string): boolean {
  try {
    return lstatSync(join(dir, 'index.json')).isFile()
  } catch {
    return false
  }
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))]
}

function validateName(name: string): string {
  const trimmed = name.trim()
  if (!/^[a-z][a-z0-9_-]{1,63}$/i.test(trimmed)) {
    throw new Error('连接器名称需为 2–64 位字母、数字、下划线或连字符，并以字母开头')
  }
  return trimmed
}

function validateUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('请输入有效的 HTTPS MCP 地址')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('MCP 地址必须是无凭据、无片段的 HTTPS URL')
  }
  return url.toString()
}

function readAppVersion(): string {
  const path = fileURLToPath(new URL('../../../package.json', import.meta.url))
  const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof value.version !== 'string') throw new Error('package.json version is missing')
  return value.version
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
