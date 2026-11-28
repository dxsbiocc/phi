import { readFileSync } from 'node:fs'

import type { EnvironmentBuilds } from '../content/environment-builds'
import type { PhiHostRequestContext } from '../engine/types'
import type { McpAuthChoice, McpAuthPrompt } from '../../../shared/agentInteractionTypes'
import { mcpOAuthAuthorizationOrigin } from '../mcp-connectors'
import {
  apiKeyConnector,
  featuredMcpApiKeyStatus,
  type ApiKeyConnectorConfig
} from '../mcp-key-credentials'
import { featuredMcpApiKeyVerifiedStatus } from '../mcp/featured-api-key-verification'
import { parseTarGz } from './archive'
import { capabilityApprovalSummary } from './capability-approval'
import {
  createCapabilityHost,
  type CapabilityHost,
  type CapabilityRunBinding
} from './capability-host'
import {
  createCapabilityService,
  type CapabilityAuthKind,
  type CapabilityAuthReceipt,
  type CapabilityInstallResult
} from './capability-service'
import { prepareContentPackageInstall } from './content-source'
import { createExternalSkillService } from './external-skills'
import type {
  InstalledPackage,
  InstallerOptions,
  LocalRegistry,
  RegistryPackageEntry
} from './installer-types'
import { localArchivePath, sha256 } from './installer-utils'
import { parsePackageManifestText, readPackageManifest, type McpPackageManifest } from './manifest'
import { readRegistryManifestAsset } from './manifest-assets'
import { searchOfficialCatalog } from './official-catalog-api'
import type { LoadedKnownRegistries } from './registries'

export interface AppCapabilityWiringOptions {
  agentDir: string
  appVersion: string
  getRuntimeRoot: () => string
  loadPackageRegistries: (
    type?: 'skill' | 'plugin' | 'wrapper' | 'mcp'
  ) => Promise<LoadedKnownRegistries>
  officialRegistryFetch: typeof fetch
  officialContentSourceOptions: () => InstallerOptions
  installedPluginNamespace: () => Promise<InstallerOptions['names']>
  environmentBuilds: Pick<EnvironmentBuilds, 'start'>
  confirmAgentModuleInstallation: (
    runtimeSessionId: string,
    summary: string,
    context: PhiHostRequestContext
  ) => Promise<boolean>
  confirmExternalSkillSearch?: (
    runtimeSessionId: string,
    summary: string,
    context: PhiHostRequestContext
  ) => Promise<boolean>
  promptForMcpAuth: (
    prompt: McpAuthPrompt,
    context?: { originSessionId?: string; signal?: AbortSignal }
  ) => Promise<McpAuthChoice>
  featuredAuthStatus: (id: string, url: string) => Promise<boolean>
  cancelFeaturedAuth?: (id: string) => Promise<unknown>
  featuredApiKeyVerifiedStatus?: (id: string) => Promise<boolean>
  resolveRun: (runtimeSessionId: string) => CapabilityRunBinding
  onResourcesChanged: (context: PhiHostRequestContext) => void
}

function tryApiKeyConnector(id: string, url: string): ApiKeyConnectorConfig | undefined {
  try {
    const config = apiKeyConnector(id)
    return config.url === url ? config : undefined
  } catch {
    return undefined
  }
}

function readArchiveMcpManifest(
  registry: LocalRegistry,
  entry: RegistryPackageEntry
): McpPackageManifest | undefined {
  const archive = readFileSync(localArchivePath(registry, entry.archive))
  if (archive.length !== entry.size || sha256(archive) !== entry.sha256) return undefined
  const manifestFile = parseTarGz(archive).find(
    (item) => item.type === 'file' && item.path === 'phi-package.yaml'
  )
  if (!manifestFile) return undefined
  const parsed = parsePackageManifestText(manifestFile.data.toString('utf8'))
  return parsed.type === 'mcp' && parsed.id === entry.id && parsed.version === entry.version
    ? parsed
    : undefined
}

function readConnectorManifest(params: {
  registry: LocalRegistry
  entry: RegistryPackageEntry
  installed?: InstalledPackage
}): McpPackageManifest | undefined {
  if (params.installed) {
    try {
      const manifest = readPackageManifest(params.installed.dir)
      if (manifest.type === 'mcp') return manifest
    } catch {
      // Fall back to verified registry metadata when the local directory cannot be read.
    }
  }
  try {
    const sidecar = readRegistryManifestAsset(params.registry.dir, params.entry)
    return sidecar?.type === 'mcp' ? sidecar : readArchiveMcpManifest(params.registry, params.entry)
  } catch {
    return undefined
  }
}

async function inspectConnectorAuthStatus(
  params: {
    registry: LocalRegistry
    entry: RegistryPackageEntry
    installed?: InstalledPackage
  },
  options: AppCapabilityWiringOptions,
  checkApiKeyVerified: (id: string) => Promise<boolean>
): Promise<{ authRequired?: CapabilityAuthKind; authenticated?: boolean } | undefined> {
  const manifest = readConnectorManifest(params)
  if (!manifest || manifest.connector.transport !== 'http' || manifest.connector.auth === 'none') {
    return undefined
  }
  if (manifest.connector.auth === 'oauth') {
    const origin = mcpOAuthAuthorizationOrigin(manifest.id, manifest.connector.url)
    if (!origin) return { authRequired: 'oauth', authenticated: false }
    const authenticated = await options
      .featuredAuthStatus(manifest.id, manifest.connector.url)
      .catch(() => false)
    return { authRequired: 'oauth', authenticated }
  }
  const apiKey = tryApiKeyConnector(manifest.id, manifest.connector.url)
  if (!apiKey) return { authRequired: 'api-key', authenticated: false }
  const authenticated = params.installed
    ? await checkApiKeyVerified(manifest.id).catch(() => false)
    : featuredMcpApiKeyStatus(manifest.id, options.agentDir)
  return { authRequired: 'api-key', authenticated }
}

async function promptOAuthConnector(
  manifest: McpPackageManifest & {
    connector: {
      transport: 'http'
      url: string
      auth: 'oauth'
      publisher: string
      homepage?: string
    }
  },
  runtimeSessionId: string,
  context: PhiHostRequestContext,
  options: AppCapabilityWiringOptions,
  assertCurrent: (context: PhiHostRequestContext) => void
): Promise<CapabilityAuthReceipt> {
  const homepageUrl = manifest.connector.homepage
  const authorizationOrigin = mcpOAuthAuthorizationOrigin(manifest.id, manifest.connector.url)
  if (!authorizationOrigin) {
    return {
      id: manifest.id,
      kind: 'oauth',
      status: 'unsupported',
      ...(homepageUrl ? { homepageUrl } : {})
    }
  }
  const already = await options
    .featuredAuthStatus(manifest.id, manifest.connector.url)
    .catch(() => false)
  if (already) return { id: manifest.id, kind: 'oauth', status: 'authenticated' }
  assertCurrent(context)
  const choice = await options.promptForMcpAuth(
    {
      runtimeSessionId,
      kind: 'oauth',
      connector: {
        id: manifest.id,
        title: manifest.title,
        publisher: manifest.connector.publisher,
        authorizationOrigin,
        ...(homepageUrl ? { homepageUrl } : {})
      }
    },
    context
  )
  if (choice.action !== 'authenticated' || context.signal?.aborted) {
    await options.cancelFeaturedAuth?.(manifest.id).catch(() => undefined)
  }
  assertCurrent(context)
  const authenticated =
    choice.action === 'authenticated' &&
    (await options.featuredAuthStatus(manifest.id, manifest.connector.url).catch(() => false))
  return {
    id: manifest.id,
    kind: 'oauth',
    status: authenticated ? 'authenticated' : 'cancelled',
    ...(homepageUrl ? { homepageUrl } : {})
  }
}

async function promptApiKeyConnector(
  manifest: McpPackageManifest & {
    connector: {
      transport: 'http'
      url: string
      auth: 'header'
      publisher: string
      homepage?: string
    }
  },
  context: PhiHostRequestContext,
  options: AppCapabilityWiringOptions,
  checkApiKeyVerified: (id: string) => Promise<boolean>,
  assertCurrent: (context: PhiHostRequestContext) => void
): Promise<CapabilityAuthReceipt> {
  const runtimeSessionId = context.originSessionId!
  const homepageUrl = manifest.connector.homepage
  const apiKey = tryApiKeyConnector(manifest.id, manifest.connector.url)
  if (!apiKey) {
    return {
      id: manifest.id,
      kind: 'api-key',
      status: 'unsupported',
      ...(homepageUrl ? { homepageUrl } : {})
    }
  }
  const already = await checkApiKeyVerified(manifest.id).catch(() => false)
  if (already) return { id: manifest.id, kind: 'api-key', status: 'authenticated' }
  assertCurrent(context)
  const choice = await options.promptForMcpAuth(
    {
      runtimeSessionId,
      kind: 'api-key',
      connector: {
        id: manifest.id,
        title: manifest.title,
        publisher: manifest.connector.publisher,
        obtainUrl: apiKey.apiKey.obtainUrl,
        ...(homepageUrl ? { homepageUrl } : {})
      }
    },
    context
  )
  assertCurrent(context)
  const authenticated =
    choice.action === 'authenticated' && (await checkApiKeyVerified(manifest.id).catch(() => false))
  return {
    id: manifest.id,
    kind: 'api-key',
    status: authenticated ? 'authenticated' : 'cancelled',
    ...(homepageUrl ? { homepageUrl } : {})
  }
}

async function promptInstalledMcpAuth(
  result: Extract<CapabilityInstallResult, { ok: true }>,
  context: PhiHostRequestContext,
  options: AppCapabilityWiringOptions,
  checkApiKeyVerified: (id: string) => Promise<boolean>,
  assertCurrent: (context: PhiHostRequestContext) => void
): Promise<void> {
  const runtimeSessionId = context.originSessionId
  if (!runtimeSessionId) return
  const targetIds = new Set([
    ...(result.root.type === 'mcp' ? [result.root.id] : []),
    ...result.usage.filter((item) => item.type === 'mcp').map((item) => item.id)
  ])
  if (targetIds.size === 0) return
  const receipts: CapabilityAuthReceipt[] = []
  for (const pkg of result.packages) {
    if (pkg.type !== 'mcp' || !targetIds.has(pkg.id)) continue
    let manifest: ReturnType<typeof readPackageManifest>
    try {
      manifest = readPackageManifest(pkg.dir)
    } catch {
      continue
    }
    if (manifest.type !== 'mcp' || manifest.connector.transport !== 'http') continue
    if (manifest.connector.auth === 'oauth') {
      receipts.push(
        await promptOAuthConnector(
          manifest as McpPackageManifest & {
            connector: {
              transport: 'http'
              url: string
              auth: 'oauth'
              publisher: string
              homepage?: string
            }
          },
          runtimeSessionId,
          context,
          options,
          assertCurrent
        )
      )
    } else if (manifest.connector.auth === 'header') {
      receipts.push(
        await promptApiKeyConnector(
          manifest as McpPackageManifest & {
            connector: {
              transport: 'http'
              url: string
              auth: 'header'
              publisher: string
              homepage?: string
            }
          },
          context,
          options,
          checkApiKeyVerified,
          assertCurrent
        )
      )
    }
  }
  if (receipts.length > 0) result.authentication = receipts
}

export function createAppCapabilityWiring(options: AppCapabilityWiringOptions): {
  capabilityHost: CapabilityHost
} {
  const checkApiKeyVerified =
    options.featuredApiKeyVerifiedStatus ?? ((id: string) => featuredMcpApiKeyVerifiedStatus(id))
  const assertCurrent = (context: PhiHostRequestContext): void =>
    capabilityHost.assertCurrent(context)

  const capabilityService = createCapabilityService({
    agentDir: options.agentDir,
    appVersion: options.appVersion,
    loadRegistries: options.loadPackageRegistries,
    searchOfficial: (query, type, signal) =>
      searchOfficialCatalog(query, type, signal, { fetch: options.officialRegistryFetch }),
    inspectMcpAuth: (params) => inspectConnectorAuthStatus(params, options, checkApiKeyVerified),
    confirm: (request, context) =>
      options.confirmAgentModuleInstallation(
        request.runtimeSessionId,
        capabilityApprovalSummary(request),
        context
      ),
    prepare: (registry, request, _options, signal) =>
      prepareContentPackageInstall(registry, request, {
        ...options.officialContentSourceOptions(),
        fetch: (input, init) =>
          options.officialRegistryFetch(input, {
            ...init,
            signal: signal
              ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
              : init?.signal
          })
      }),
    installerOptions: async () => ({
      ...options.officialContentSourceOptions(),
      runtimeRoot: options.getRuntimeRoot(),
      names: await options.installedPluginNamespace(),
      build: (descriptor, buildOptions) => options.environmentBuilds.start(descriptor, buildOptions)
    }),
    assertCurrent
  })

  const externalSkillService = createExternalSkillService({
    agentDir: options.agentDir,
    appVersion: options.appVersion,
    fetch: options.officialRegistryFetch,
    ...(options.confirmExternalSkillSearch
      ? {
          confirmSearch: (request, context) =>
            options.confirmExternalSkillSearch!(request.runtimeSessionId, request.question, context)
        }
      : {}),
    confirm: (request, context) =>
      options.confirmAgentModuleInstallation(request.runtimeSessionId, request.question, context),
    assertCurrent
  })

  const capabilityHost: CapabilityHost = createCapabilityHost({
    service: capabilityService,
    external: externalSkillService,
    onInstalled: async (result, context) => {
      options.onResourcesChanged(context)
      if (
        result &&
        typeof result === 'object' &&
        'ok' in result &&
        result.ok === true &&
        'installed' in result &&
        result.installed === true
      ) {
        await promptInstalledMcpAuth(
          result as Extract<CapabilityInstallResult, { ok: true }>,
          context,
          options,
          checkApiKeyVerified,
          assertCurrent
        )
      }
    },
    resolveRun: options.resolveRun
  })

  return { capabilityHost }
}
