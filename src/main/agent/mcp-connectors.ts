import {
  OFFICIAL_REGISTRY_ID,
  isOfficialRegistryDirectory,
  officialRegistryDirectory,
  syncOfficialRegistry,
  type OfficialRegistryOptions
} from './packages/official-registry'
import { prepareContentPackageInstall } from './packages/content-source'
import {
  isOfficialConnectorRegistryDirectory,
  readOfficialConnectorRegistry,
  syncOfficialConnectorRegistry
} from './packages/official-connector-registry'
import { readRegistryManifestAsset } from './packages/manifest-assets'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import semver from 'semver'

import type {
  FeaturedMcpConnector,
  McpConnectorSetupPhase,
  RemoteMcpConnectorOptions,
  RemoteMcpOAuthCredentials
} from '../../shared/mcpConnectorCatalog'
import type { EnvironmentBuildStartOptions } from './content/environment-builds'
import type { EnvironmentDescriptor } from './content/environment-refs'
import { resolveCuratedResourceIcon } from './curated-icons'
import { findResourceIcon, registerResourceIconAsset } from './resource-icons'
import type { RegistryIconAsset } from '../../shared/resourceIconTypes'
import { listActiveMcpPackages } from './packages/mcp-store'
import { parseTarGz } from './packages/archive'
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
import { materializeConnectorRegistry } from './packages/materialize-registry'
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
import { validateName } from './mcp/connector-name'

import { isRecord } from '../../shared/guards'
export { MCP_PACKAGE_MARKER_FIELD, refreshPersistedManagedStdioServers }
export { validateName } from './mcp/connector-name'

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
  /** Verified loaded indexes, including the official metadata-only catalog. */
  registries?: readonly LocalRegistry[]
  /** Explicit legacy source for tooling/tests; domain content is never loaded implicitly. */
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
  official?: boolean
  manifest: McpPackageManifest
  registryDir: string
  packageDir?: string
  iconAsset?: RegistryIconAsset
  source?: FeaturedMcpConnector['source']
  notice?: string
  directoryAuthBlocked?: boolean
}

/** Catalog data from supplied verified indexes and installed connectors. */
export function listConnectorCatalog(
  options: ConnectorCatalogOptions = {}
): FeaturedMcpConnector[] {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const appVersion = options.appVersion ?? readAppVersion()
  if (!semver.valid(appVersion)) throw new Error(`Invalid app version: ${appVersion}`)
  const config = readMcpConfig(agentDir)
  const servers = config.mcpServers ?? {}
  const sources: CatalogSource[] = []
  const installed = listActiveMcpPackages(agentDir)
  const installedRoots = new Map(installed.map((entry) => [entry.id, entry.dir]))
  const installedTrust = new Map(
    listInstalledPackages({ agentDir })
      .filter((entry) => entry.type === 'mcp')
      .map((entry) => [entry.id, entry.trust])
  )

  for (const registry of options.registries ?? []) {
    sources.push(...catalogSourcesFromRegistryIndex(registry))
  }
  if (options.bundledRegistryDir && existsSync(options.bundledRegistryDir)) {
    sources.push(...catalogSourcesFromRegistry(options.bundledRegistryDir))
  } else if (options.bundledConnectorsDir) {
    const root = options.bundledConnectorsDir
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
        sources.push({
          manifest,
          registryDir: entry.dir,
          packageDir: entry.dir,
          source: {
            kind: 'installed',
            label: '已安装',
            trust: installedTrust.get(entry.id) ?? 'imported'
          }
        })
      }
    } catch {
      // A broken installation must not hide the other catalog entries.
    }
  }

  const selected = new Map<string, CatalogSource>()
  for (const source of sources) {
    const current = selected.get(source.manifest.id)
    if (current?.source?.kind === 'github' && source.source?.kind === 'github') {
      current.notice ??= `Ignored a duplicate Connector from ${source.source.label}`
      continue
    }
    if (
      !current ||
      (source.official === true && current.official !== true) ||
      (source.official === current.official &&
        semver.gt(source.manifest.version, current.manifest.version))
    ) {
      selected.set(source.manifest.id, source)
    }
  }

  return [...selected.values()]
    .map(
      ({ manifest, registryDir, packageDir, iconAsset, source, notice, directoryAuthBlocked }) => {
        const connector = manifest.connector
        const entry = servers[manifest.id]
        const marker = readManagedMarker(entry)
        const installedRoot = installedRoots.get(manifest.id)
        const icon =
          (installedRoot ? findResourceIcon(installedRoot) : undefined) ??
          (packageDir ? findResourceIcon(packageDir) : undefined) ??
          (iconAsset ? registerResourceIconAsset(registryDir, iconAsset) : undefined) ??
          (installedRoot ? resolveCuratedResourceIcon('mcp', manifest.id) : undefined)
        const needsNewerApp = manifest.minAppVersion
          ? semver.lt(appVersion, manifest.minAppVersion)
          : false
        const unavailableKind = needsNewerApp
          ? 'app-version'
          : directoryAuthBlocked
            ? 'authorization'
            : undefined
        const unavailableReason = needsNewerApp
          ? `Requires Phi ${manifest.minAppVersion} or later`
          : directoryAuthBlocked
            ? 'Authorization is currently unavailable for this Connector'
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
          unavailableReason,
          unavailableKind,
          ...(source ? { source } : {}),
          ...(notice ? { notice } : {})
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
      }
    )
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
  options: InstallerOptions &
    OfficialRegistryOptions & {
      onPhase?: (phase: Extract<McpConnectorSetupPhase, 'downloading' | 'installing'>) => void
    } = {}
): Promise<InstalledPackage[]> {
  if (isOfficialConnectorRegistryDirectory(registryDir, options.agentDir)) {
    const registry = readOfficialConnectorRegistry(registryDir, options)
    options.onPhase?.('installing')
    return installConnectorFromRegistry(registry, id, version, options)
  }
  if (
    registryDir === OFFICIAL_REGISTRY_ID ||
    isOfficialRegistryDirectory(registryDir, options.agentDir)
  ) {
    options.onPhase?.('downloading')
    const registry =
      registryDir === OFFICIAL_REGISTRY_ID
        ? await syncOfficialConnectorRegistry(options)
        : resolve(registryDir) === resolve(officialRegistryDirectory(options.agentDir))
          ? await syncOfficialRegistry(options)
          : {
              ...readRegistry(registryDir, options),
              id: OFFICIAL_REGISTRY_ID,
              kind: 'official' as const
            }
    const prepared = await prepareContentPackageInstall(
      registry,
      { type: 'mcp', id, ...(version ? { version } : {}) },
      options
    )
    options.onPhase?.('installing')
    return installConnectorFromRegistry(prepared, id, version, options)
  }
  const source = resolve(registryDir)
  if (isRegistryDirectory(source)) {
    const registry = readRegistry(source)
    options.onPhase?.('installing')
    return installConnectorFromRegistry(registry, id, version, options)
  }

  const packageDir = connectorSourceDir(source, id)
  const manifest = readPackageManifest(packageDir)
  if (manifest.type !== 'mcp' || manifest.id !== id) {
    throw new Error(`Connector source does not match the request: mcp:${id}`)
  }
  if (version && manifest.version !== version) {
    throw new Error(`Connector ${id} has no version ${version}`)
  }
  const temporary = mkdtempSync(join(tmpdir(), 'phi-connector-registry-'))
  try {
    const registry = materializeConnectorRegistry(packageDir, temporary, source, 'imported')
    options.onPhase?.('installing')
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
  if (!installed) throw new Error(`MCP package ${id} is not installed`)
  const manifest = readPackageManifest(installed.dir)
  if (manifest.type !== 'mcp') throw new Error(`MCP package ${id} has an invalid manifest type`)
  const environment = describeMcpPackageEnvironment(manifest, installed.dir, {
    agentDir,
    environmentsDir: options.environmentsDir,
    platform: options.platform
  })
  if (!environment) throw new Error(`HTTP Connector ${id} has no buildable environment`)
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
    throw new Error('The API key Connector URL does not match the official URL')
  }
  if (apiKeyConnectorEntry && oauth) {
    throw new Error('This Connector uses an API key and does not accept OAuth client details')
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
      throw new Error('Connector configuration changed. Refresh and try again.')
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
        throw new Error(
          `A Connector named ${validatedName} already uses different authentication. Remove or rename it first.`
        )
      }
      if (apiKeyConnectorEntry) {
        if (!isPhiManagedApiKeyEntry(existing, validatedName, validatedUrl)) {
          throw new Error(
            `Custom MCP configuration ${validatedName} already exists. Remove or rename it first.`
          )
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
    throw new Error(`MCP configuration ${validatedName} already exists`)
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
    throw new Error(
      'Multiple OAuth configurations use this service URL. Keep one or use the catalog Connector name.'
    )
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
    throw new Error('Select a saved custom HTTP Connector')
  }
  const url = typeof entry.url === 'string' ? validateUrl(entry.url) : undefined
  const oauth = validateRemoteConnectorOptions({ oauth: entry.oauth }).oauth
  if (!url || !oauth?.clientId) throw new Error('Custom Connectors require a saved OAuth Client ID')
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
    throw new Error('Connector configuration changed. Refresh and try again.')
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
    if (!candidate) throw new Error(`Package mcp:${id} was not found in the registry`)
    if (!semver.gt(candidate.version, installed.version)) {
      throw new Error(
        `Upgrade version must be newer than ${installed.version}; received ${candidate.version}`
      )
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
        `Invalid Connector package ${dir}: ${validation.errors
          .map((problem) => `${problem.path}: ${problem.message}`)
          .join('; ')}`
      )
    }
    return { manifest: validation.package.manifest, registryDir: directory, packageDir: dir }
  })
}

function catalogSourcesFromRegistry(dir: string): CatalogSource[] {
  return catalogSourcesFromRegistryIndex(readRegistry(dir))
}

function catalogSourcesFromRegistryIndex(registry: LocalRegistry): CatalogSource[] {
  const official =
    registry.id === OFFICIAL_REGISTRY_ID &&
    (registry.kind === 'official' || registry.trust === 'official')
  const source: FeaturedMcpConnector['source'] = registry.source
    ? {
        kind: 'github',
        label: `GitHub · ${registry.source.repo}@${registry.source.sha.slice(0, 7)}`,
        trust: 'imported',
        sourceId: registry.source.id,
        sha: registry.source.sha
      }
    : official
      ? { kind: 'official', label: registry.label ?? 'Phi Packages', trust: registry.trust }
      : {
          kind: 'directory',
          label: registry.label ?? '用户软件源',
          trust: registry.trust
        }
  return registry.packages
    .filter((entry) => entry.type === 'mcp')
    .map((entry) => ({
      ...(official ? { official: true } : {}),
      manifest: manifestFromRegistryEntry(registry, entry),
      registryDir: registry.dir,
      directoryAuthBlocked: entry.directoryAuthBlocked,
      source,
      ...(entry.iconAsset ? { iconAsset: entry.iconAsset } : {})
    }))
}

function manifestFromRegistryEntry(
  registry: LocalRegistry,
  entry: RegistryPackageEntry
): McpPackageManifest {
  const sidecar = readRegistryManifestAsset(registry.dir, entry)
  if (sidecar) {
    if (sidecar.type !== 'mcp') throw new Error(`Invalid Connector manifest type: ${entry.id}`)
    return sidecar
  }
  const archive = readFileSync(localArchivePath(registry, entry.archive))
  if (archive.length !== entry.size || sha256(archive) !== entry.sha256) {
    throw new Error(`MCP package archive verification failed: ${entry.id}@${entry.version}`)
  }
  const manifestFile = parseTarGz(archive).find(
    (item) => item.type === 'file' && item.path === 'phi-package.yaml'
  )
  if (!manifestFile) throw new Error(`MCP package ${entry.id} is missing phi-package.yaml`)
  const manifest = parsePackageManifestText(manifestFile.data.toString('utf8'))
  if (manifest.type !== 'mcp' || manifest.id !== entry.id || manifest.version !== entry.version) {
    throw new Error(
      `MCP package manifest does not match the registry: ${entry.id}@${entry.version}`
    )
  }
  return manifest
}

function connectorSourceDir(source: string, id: string): string {
  const direct = isPackageDirectory(source) ? source : join(source, id)
  if (!isPackageDirectory(direct)) throw new Error(`Connector source does not exist: ${id}`)
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

function validateRemoteConnectorOptions(options: unknown): RemoteMcpConnectorOptions {
  if (options === undefined) return {}
  if (
    !isRecord(options) ||
    Object.keys(options).some((key) => key !== 'oauth' && key !== 'expectedOAuth')
  ) {
    throw new Error('Invalid Connector authentication settings')
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
    throw new Error('Invalid OAuth client settings')
  }
  const clientId = validateOAuthField(value.clientId, 'Client ID', 1024)
  const clientSecret = validateOAuthField(value.clientSecret, 'Client Secret', 4096)
  if (clientSecret && !clientId)
    throw new Error('OAuth Client ID is required when a Client Secret is provided')
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
    throw new Error(
      `Invalid OAuth ${label}: must not contain control characters or exceed ${maxLength} characters`
    )
  }
  return value.trim() || undefined
}

function validateUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Enter a valid HTTPS MCP URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('MCP URLs must use HTTPS without credentials or fragments')
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

function configPath(agentDir: string): string {
  return mcpConfigPath(agentDir)
}

function readConfig(path: string): McpConfig {
  if (!existsSync(path)) return { mcpServers: {} }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(parsed)) throw new Error('Invalid MCP configuration file format')
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw new Error('mcpServers must be an object in the MCP configuration')
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
  if (!MCP_SERVER_NAME.test(name)) throw new Error('Invalid Connector name')
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
