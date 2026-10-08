import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import semver from 'semver'

import type {
  FeaturedMcpConnector,
  RemoteMcpConnectorOptions,
  RemoteMcpOAuthCredentials
} from '../../shared/mcpConnectorCatalog'
import type { EnvironmentBuildStartOptions } from './content/environment-builds'
import type { EnvironmentDescriptor } from './content/environment-refs'
import { findResourceIcon, registerResourceIconAsset } from './resource-icons'
import type { RegistryIconAsset } from '../../shared/resourceIconTypes'
import { listActiveMcpPackages } from './packages/mcp-store'
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
  RegistryPackageEntry,
  RegistryTrustTier
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
import { API_KEY_CONNECTOR_IDS, apiKeyConnector } from './mcp-key-credentials'
import {
  MCP_PACKAGE_MARKER_FIELD,
  mcpConfigPath,
  packageIdFromMcpEntry,
  readMcpConfig,
  refreshPersistedManagedStdioServers,
  setMcpPackageConfigEnabled,
  writeMcpConfig,
  type McpConfig,
  type McpPackageConfigOptions
} from './mcp/package-config'
import {
  describeMcpPackageEnvironment,
  type McpEnvironmentLookupOptions
} from './mcp/package-environment'
import { readManagedMarker } from './mcp/stdio-environment'

export { MCP_PACKAGE_MARKER_FIELD, refreshPersistedManagedStdioServers }

const MCP_SERVER_NAME = /^[a-zA-Z0-9_.-]{1,100}$/

const OAUTH_CONNECTORS: Record<string, { url: string; authorizationOrigin: string }> = {
  notion: { url: 'https://mcp.notion.com/mcp', authorizationOrigin: 'https://mcp.notion.com' },
  composio: {
    url: 'https://connect.composio.dev/mcp',
    authorizationOrigin: 'https://connect.composio.dev'
  },
  linear: { url: 'https://mcp.linear.app/mcp', authorizationOrigin: 'https://mcp.linear.app' },
  figma: { url: 'https://mcp.figma.com/mcp', authorizationOrigin: 'https://www.figma.com' },
  canva: { url: 'https://mcp.canva.com/mcp', authorizationOrigin: 'https://mcp.canva.com' },
  cbioportal: {
    url: 'https://mcp.cbioportal.org/db/mcp',
    authorizationOrigin: 'https://mcp.cbioportal.org'
  },
  biorender: {
    url: 'https://mcp.services.biorender.com/mcp',
    authorizationOrigin: 'https://mcp.services.biorender.com'
  }
}

/** App-owned allowlist: registry manifests cannot choose browser authorization origins. */
export function mcpOAuthAuthorizationOrigin(id: string, url: string): string | undefined {
  const known = OAUTH_CONNECTORS[id]
  return known?.url === url ? known.authorizationOrigin : undefined
}

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
  packageDir?: string
  iconAsset?: RegistryIconAsset
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
  const installed = listActiveMcpPackages(agentDir)
  const installedRoots = new Map(installed.map((entry) => [entry.id, entry.dir]))

  if (options.bundledRegistryDir && existsSync(options.bundledRegistryDir)) {
    sources.push(...catalogSourcesFromRegistry(options.bundledRegistryDir))
  } else if (!options.bundledRegistryDir) {
    const root = options.bundledConnectorsDir ?? getBundledConnectorsDir()
    if (existsSync(root)) sources.push(...catalogSourcesFromDirectory(root))
  }
  for (const dir of uniquePaths(options.registryDirs ?? [])) {
    if (options.bundledRegistryDir && resolve(dir) === resolve(options.bundledRegistryDir)) continue
    if (existsSync(dir)) sources.push(...catalogSourcesFromRegistry(dir))
  }
  // Installed connectors retain presentation metadata when their original source is unavailable.
  for (const entry of installed) {
    try {
      const manifest = readPackageManifest(entry.dir)
      if (
        manifest.type === 'mcp' &&
        manifest.id === entry.id &&
        manifest.version === entry.version
      ) {
        sources.push({ manifest, registryDir: entry.dir, packageDir: entry.dir })
      }
    } catch {
      // A broken installation must not hide the other catalog entries.
    }
  }

  const selected = new Map<string, CatalogSource>()
  for (const source of sources) {
    const current = selected.get(source.manifest.id)
    if (!current || semver.gt(source.manifest.version, current.manifest.version)) {
      selected.set(source.manifest.id, source)
    }
  }

  return [...selected.values()]
    .map(({ manifest, registryDir, packageDir, iconAsset }) => {
      const connector = manifest.connector
      const entry = servers[manifest.id]
      const marker = readManagedMarker(entry)
      const installedRoot = installedRoots.get(manifest.id)
      const icon =
        (installedRoot ? findResourceIcon(installedRoot) : undefined) ??
        (packageDir ? findResourceIcon(packageDir) : undefined) ??
        (iconAsset ? registerResourceIconAsset(registryDir, iconAsset) : undefined)
      const unavailableReason =
        manifest.minAppVersion && semver.lt(appVersion, manifest.minAppVersion)
          ? `需要 Phi ${manifest.minAppVersion} 或更高版本`
          : undefined
      const result: FeaturedMcpConnector = {
        id: manifest.id,
        ...(icon ? { icon } : {}),
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
                ? '需要 API key'
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
        result.oauthAuthorizationOrigin = mcpOAuthAuthorizationOrigin(manifest.id, connector.url)
        if (connector.auth === 'header') {
          try {
            const known = apiKeyConnector(manifest.id)
            if (known.url === connector.url) result.apiKey = known.apiKey
          } catch {
            // Third-party header-auth packages remain visible, but v1 lacks the
            // fields needed for Phi's provider-specific credential UI.
          }
        }
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
    const trust = isBundledConnectorSource(source) ? 'builtin' : 'imported'
    const registry = materializeConnectorRegistry(packageDir, temporary, source, trust)
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
  agentDir = getPhiAgentDir(),
  options?: RemoteMcpConnectorOptions
): void {
  const validatedName = validateName(name)
  const validatedUrl = validateUrl(url)
  const validatedOptions = validateRemoteConnectorOptions(options)
  const oauth = validatedOptions.oauth
  const apiKeyConnectorEntry = knownApiKeyConnector(validatedName)
  if (apiKeyConnectorEntry && validatedUrl !== apiKeyConnectorEntry.url) {
    throw new Error('API key 连接器地址与官方地址不匹配')
  }
  if (apiKeyConnectorEntry && oauth) {
    throw new Error('此连接器使用 API key，不支持 OAuth 客户端信息')
  }
  const config = readMcpConfig(agentDir)
  const servers = config.mcpServers ?? {}
  const existing = servers[validatedName]
  if (validatedOptions.expectedOAuth !== undefined) {
    if (
      !isRecord(existing) ||
      existing.type !== 'http' ||
      existing.url !== validatedUrl ||
      existing.command !== undefined ||
      existing[MCP_PACKAGE_MARKER_FIELD] !== undefined ||
      apiKeyConnectorEntry ||
      (isRecord(existing.auth) && existing.auth.type === 'apikey') ||
      !oauthCredentialsMatch(existing.oauth, validatedOptions.expectedOAuth)
    ) {
      throw new Error('连接器配置已变化，请刷新后重试')
    }
    const updated = { ...existing }
    if (oauth) updated.oauth = oauth
    else delete updated.oauth
    writeMcpConfig({ ...config, mcpServers: { ...servers, [validatedName]: updated } }, agentDir)
    return
  }
  if (existing !== undefined) {
    if (isRecord(existing) && existing.url === validatedUrl) {
      if (
        oauth &&
        (existing.type !== 'http' ||
          existing.command !== undefined ||
          !isRecord(existing.oauth) ||
          existing.oauth.clientId !== oauth.clientId ||
          existing.oauth.clientSecret !== oauth.clientSecret)
      ) {
        throw new Error(`已有名为 ${validatedName} 的连接器使用不同认证信息，请先移除或重命名`)
      }
      if (apiKeyConnectorEntry) {
        if (!isPhiManagedApiKeyEntry(existing, validatedName, validatedUrl)) {
          throw new Error(`已有名为 ${validatedName} 的自定义 MCP 配置，请先移除或重命名`)
        }
        if (existing.enabled !== false) {
          writeMcpConfig(
            {
              ...config,
              mcpServers: {
                ...servers,
                [validatedName]: { ...existing, enabled: false }
              }
            },
            agentDir
          )
        }
      }
      return
    }
    throw new Error(`已有名为 ${validatedName} 的 MCP 配置`)
  }
  writeMcpConfig(
    {
      ...config,
      mcpServers: {
        ...servers,
        [validatedName]: {
          type: 'http',
          url: validatedUrl,
          enabled: !apiKeyConnectorEntry,
          ...(oauth ? { oauth } : {})
        }
      }
    },
    agentDir
  )
}

/** Resolve saved client credentials only for the requested endpoint. Never expose these in summaries. */
export function readRemoteMcpOAuthCredentials(
  name: string,
  url: string,
  agentDir = getPhiAgentDir()
): RemoteMcpConnectorOptions['oauth'] {
  const validatedUrl = validateUrl(url)
  const servers = readMcpConfig(agentDir).mcpServers ?? {}
  const matches = Object.entries(servers).filter(
    ([, entry]) =>
      isRecord(entry) &&
      entry.url === validatedUrl &&
      entry.command === undefined &&
      (entry.type === undefined || entry.type === 'http') &&
      isRecord(entry.oauth)
  )
  const named = matches.find(([entryName]) => entryName === name)
  if (!named && matches.length > 1) {
    throw new Error('同一服务地址有多个 OAuth 配置，请保留一个或使用目录中的连接器名称')
  }
  const entry = (named ?? matches[0])?.[1]
  if (!isRecord(entry) || !isRecord(entry.oauth)) return undefined
  return validateRemoteConnectorOptions({
    oauth: { clientId: entry.oauth.clientId, clientSecret: entry.oauth.clientSecret }
  }).oauth
}

/** Private setup data for an exact custom entry; never accepted from a renderer request. */
export function readCustomRemoteMcpConnector(
  name: string,
  agentDir = getPhiAgentDir()
): { name: string; url: string; oauth: { clientId: string; clientSecret?: string } } {
  const validatedName = validateName(name)
  const entry = readMcpConfig(agentDir).mcpServers?.[validatedName]
  if (
    !isRecord(entry) ||
    entry.type !== 'http' ||
    entry.command !== undefined ||
    entry[MCP_PACKAGE_MARKER_FIELD] !== undefined ||
    knownApiKeyConnector(validatedName) ||
    (isRecord(entry.auth) && entry.auth.type === 'apikey')
  ) {
    throw new Error('请选择已保存的自定义 HTTP 连接器')
  }
  const url = typeof entry.url === 'string' ? validateUrl(entry.url) : undefined
  const oauth = validateRemoteConnectorOptions({ oauth: entry.oauth }).oauth
  if (!url || !oauth?.clientId) throw new Error('自定义连接器需要已保存的 OAuth Client ID')
  return { name: validatedName, url, oauth: { ...oauth, clientId: oauth.clientId } }
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
    return { manifest: validation.package.manifest, registryDir: directory, packageDir: dir }
  })
}

function catalogSourcesFromRegistry(dir: string): CatalogSource[] {
  const registry = readRegistry(dir)
  return registry.packages
    .filter((entry) => entry.type === 'mcp')
    .map((entry) => ({
      manifest: manifestFromRegistryEntry(registry, entry),
      registryDir: registry.dir,
      ...(entry.iconAsset ? { iconAsset: entry.iconAsset } : {})
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
  registryId: string,
  trust: RegistryTrustTier
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
    trust,
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    packages: [entry]
  }
}

function isBundledConnectorSource(source: string): boolean {
  try {
    return realpathSync(source) === realpathSync(getBundledConnectorsDir())
  } catch {
    return false
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
  if (typeof name !== 'string') throw new Error('连接器名称无效')
  const trimmed = name.trim()
  if (!/^[a-z][a-z0-9_-]{1,63}$/i.test(trimmed)) {
    throw new Error('连接器名称需为 2–64 位字母、数字、下划线或连字符，并以字母开头')
  }
  return trimmed
}

function validateRemoteConnectorOptions(options: unknown): RemoteMcpConnectorOptions {
  if (options === undefined) return {}
  if (
    !isRecord(options) ||
    Object.keys(options).some((key) => key !== 'oauth' && key !== 'expectedOAuth')
  ) {
    throw new Error('连接器认证设置无效')
  }
  const oauth = validateOAuthCredentials(options.oauth)
  const expectedOAuth =
    options.expectedOAuth === undefined
      ? undefined
      : (validateOAuthCredentials(
          options.expectedOAuth === null ? undefined : options.expectedOAuth
        ) ?? null)
  return {
    ...(oauth ? { oauth } : {}),
    ...(expectedOAuth !== undefined ? { expectedOAuth } : {})
  }
}

function validateOAuthCredentials(value: unknown): RemoteMcpOAuthCredentials | undefined {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'clientId' && key !== 'clientSecret')
  ) {
    throw new Error('OAuth 客户端设置无效')
  }
  const clientId = validateOAuthField(value.clientId, 'Client ID', 1024)
  const clientSecret = validateOAuthField(value.clientSecret, 'Client Secret', 4096)
  if (clientSecret && !clientId) throw new Error('填写 OAuth Client Secret 时必须提供 Client ID')
  if (!clientId) return undefined
  return { clientId, ...(clientSecret ? { clientSecret } : {}) }
}

function oauthCredentialsMatch(
  value: unknown,
  expected: RemoteMcpOAuthCredentials | null
): boolean {
  if (expected === null) return value === undefined
  if (!isRecord(value)) return false
  const keys = Object.keys(expected) as Array<keyof RemoteMcpOAuthCredentials>
  return (
    Object.keys(value).length === keys.length && keys.every((key) => value[key] === expected[key])
  )
}

function validateOAuthField(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    throw new Error(`OAuth ${label} 无效，不能包含控制字符且长度不能超过 ${maxLength}`)
  }
  return value.trim() || undefined
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

function isPhiManagedApiKeyEntry(
  value: unknown,
  id: string,
  url: string
): value is {
  type: 'http'
  url: string
  enabled: boolean
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  const keys = Object.keys(entry).sort().join(',')
  const recognizedShape =
    keys === 'enabled,type,url' ||
    (keys === 'enabled,phiPackage,type,url' && entry.phiPackage === id)
  return (
    recognizedShape &&
    entry.type === 'http' &&
    entry.url === url &&
    typeof entry.enabled === 'boolean'
  )
}

function knownApiKeyConnector(id: string): ReturnType<typeof apiKeyConnector> | undefined {
  try {
    return apiKeyConnector(id)
  } catch {
    return undefined
  }
}

/** Upgrade older managed entries before Pi scans mcp.json. */
export function disableFeaturedApiKeyAutoDiscovery(agentDir = getPhiAgentDir()): void {
  const config = readMcpConfig(agentDir)
  const servers = config.mcpServers ?? {}
  let changed = false
  const updated = { ...servers }
  for (const id of API_KEY_CONNECTOR_IDS) {
    const entry = servers[id]
    const connector = apiKeyConnector(id)
    if (isPhiManagedApiKeyEntry(entry, id, connector.url) && entry.enabled) {
      updated[id] = { ...entry, enabled: false }
      changed = true
    }
  }
  if (changed) writeMcpConfig({ ...config, mcpServers: updated }, agentDir)
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

function configPath(agentDir: string): string {
  return mcpConfigPath(agentDir)
}

function readConfig(path: string): McpConfig {
  if (!existsSync(path)) return { mcpServers: {} }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(parsed)) throw new Error('MCP 配置文件格式无效')
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw new Error('MCP 配置中的 mcpServers 必须是对象')
  }
  return parsed as McpConfig
}

function writeConfig(path: string, config: McpConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporaryPath, path)
}

function disabledServerNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is string => typeof item === 'string' && MCP_SERVER_NAME.test(item)
  )
}

function managedApiKeyEntry(name: string, value: unknown): boolean {
  try {
    return isPhiManagedApiKeyEntry(value, name, apiKeyConnector(name).url)
  } catch {
    return false
  }
}

function ownedMcpConfigPath(sourcePath: string, agentDir: string): boolean {
  const normalized = sourcePath.replaceAll('\\', '/')
  if (normalized === configPath(agentDir).replaceAll('\\', '/')) return true
  return (
    normalized.endsWith('/.phi/mcp.json') ||
    normalized.endsWith('/.mcp.json') ||
    normalized.endsWith('/.omp/mcp.json') ||
    normalized.endsWith('/.pi/mcp.json')
  )
}

function setStoredEntryEnabled(config: McpConfig, name: string, enabled: boolean): boolean {
  const entry = config.mcpServers?.[name]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  // API key entries must stay disabled in the file. Pi would otherwise connect
  // them without the key; Phi injects that key in memory while the switch is on.
  if (managedApiKeyEntry(name, entry)) return false
  const record = entry as Record<string, unknown>
  if ((record.enabled !== false) === enabled) return false
  config.mcpServers![name] = { ...record, enabled }
  return true
}

export function readMcpServerEntry(
  name: string,
  agentDir = getPhiAgentDir()
): Record<string, unknown> | undefined {
  const entry = readConfig(configPath(agentDir)).mcpServers?.[name]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  return entry as Record<string, unknown>
}

/** Whether this connector's tools should be offered to the model. */
export function isInjectedMcpServer(name: string, value: unknown, userDisabled: boolean): boolean {
  if (userDisabled) return false
  if (managedApiKeyEntry(name, value)) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return (value as Record<string, unknown>).enabled !== false
}

export function readDisabledMcpServerNames(agentDir = getPhiAgentDir()): string[] {
  return disabledServerNames(readConfig(configPath(agentDir)).disabledServers)
}

export function isMcpConnectorUserDisabled(name: string, agentDir = getPhiAgentDir()): boolean {
  return readDisabledMcpServerNames(agentDir).includes(name)
}

/** User on/off switch. API key entries stay `enabled: false` so Pi does not connect them without the key. */
export function setMcpConnectorEnabled(
  name: string,
  enabled: boolean,
  sourcePath?: string,
  agentDir = getPhiAgentDir()
): void {
  if (!MCP_SERVER_NAME.test(name)) throw new Error('连接器名称无效')
  const userPath = configPath(agentDir)
  const userConfig = readConfig(userPath)
  const disabled = new Set(disabledServerNames(userConfig.disabledServers))
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  if (disabled.size > 0) userConfig.disabledServers = [...disabled].sort()
  else delete userConfig.disabledServers

  const entryPath = sourcePath && ownedMcpConfigPath(sourcePath, agentDir) ? sourcePath : undefined
  const sameFile = !entryPath || entryPath === userPath
  if (sameFile) setStoredEntryEnabled(userConfig, name, enabled)
  writeConfig(userPath, userConfig)

  if (entryPath && !sameFile) {
    const config = readConfig(entryPath)
    if (setStoredEntryEnabled(config, name, enabled)) writeConfig(entryPath, config)
  }
}
