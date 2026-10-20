// Owns registration and request orchestration for the MCP Connector IPC domain.
// Receives shared package, session, workspace, and custom-authorization collaborators.
// It does not own application lifecycle, renderer windows, or engine construction.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import type { RemoteMcpConnectorOptions } from '../../shared/mcpConnectorCatalog'
import { writeAppLog } from '../agent/app-logger'
import type { EnvironmentBuilds } from '../agent/content/environment-builds'
import { getRuntimeRoot } from '../agent/envs/runtime'
import { getPhiEngine } from '../agent/engine/in-process-engine'
import {
  addRemoteMcpConnector,
  connectorEnvironmentBuildAction,
  disableFeaturedApiKeyAutoDiscovery,
  installCatalogConnector,
  listConnectorCatalog,
  mcpOAuthAuthorizationOrigin,
  readCustomRemoteMcpConnector,
  readMcpServerEntry,
  refreshPersistedManagedStdioServers,
  removeRemoteMcpConnector,
  setMcpConnectorEnabled,
  setMcpPackageEnabled,
  uninstallCatalogConnector,
  validateName
} from '../agent/mcp-connectors'
import { withConnectorMetadata } from '../agent/mcp-server-view'
import {
  API_KEY_CONNECTOR_IDS,
  apiKeyConnector,
  clearFeaturedMcpApiKey,
  isFeaturedMcpApiKeyInstalled,
  setFeaturedMcpApiKey
} from '../agent/mcp-key-credentials'
import { validateFeaturedMcpApiKey } from '../agent/mcp-key-validation'
import { ConnectorSetupTracker, type ConnectorSetupReporter } from '../agent/mcp/connector-setup'
import {
  addLocalMcpConnector,
  listLocalMcpRuntimes,
  removeLocalMcpConnector,
  validateLocalConnectorRequest
} from '../agent/mcp/custom-stdio'
import {
  apiKeyDigest,
  featuredMcpApiKeyVerifiedStatus,
  syncFeaturedMcpApiKeySessions,
  verificationExpiresAt,
  verifiedMcpApiKeys
} from '../agent/mcp/featured-api-key-verification'
import {
  checkedRemoteMcpTrustMutation,
  remoteMcpProjectContext as resolveRemoteMcpProjectContext
} from '../agent/mcp/remote-mcp-trust-request'
import { createLocalConnectorJobs } from '../agent/mcp/local-connector-jobs'
import {
  loadRemoteProjectMcpCatalog,
  revokeRemoteProjectMcpTrust,
  trustRemoteProjectMcp,
  type RemoteProjectMcpContext
} from '../agent/mcp/remote-project-mcp-service'
import type { InstallerOptions, LocalRegistry } from '../agent/packages/installer-types'
import { setEnabled } from '../agent/enablement'
import { listGlobalMcpServers, listMcpServers } from '../agent/resources'

type OfficialContentSourceOptions = InstallerOptions & {
  agentDir: string
  appVersion: string
  fetch: typeof fetch
  buildMcpEnvironment: NonNullable<InstallerOptions['buildMcpEnvironment']>
  verifyMcpStdio: NonNullable<InstallerOptions['verifyMcpStdio']>
}

export interface PendingCustomMcpAuthorization {
  attemptId: string
  serverUrl: string
  configDigest: string
  cancelled: boolean
  authorizationOrigin?: string
  authorizationPath?: string
}

export interface McpIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  lifecycle: {
    getAppVersion: () => string
    invalidateAgentSession: () => Promise<void>
    sendToAllWindows: (channel: string, ...args: unknown[]) => void
  }
  workspace: {
    agentDir: string
    getCurrentCwd: () => string
    isRemoteResourceScope: (cwd?: string) => boolean
    resolveRemoteProjectContext: (cwd?: string) => RemoteProjectMcpContext
  }
  packages: {
    loadPackageRegistries: (
      type: 'mcp',
      forceRefresh?: boolean
    ) => Promise<{ registries: readonly LocalRegistry[] }>
    officialContentSourceOptions: () => OfficialContentSourceOptions
    environmentBuilds: Pick<EnvironmentBuilds, 'start'>
  }
  customAuthorization: {
    pending: Map<string, PendingCustomMcpAuthorization>
    parseUrl: (value: unknown) => URL
    configDigest: (connector: ReturnType<typeof readCustomRemoteMcpConnector>) => string
  }
}

function createMcpIpcContext(options: McpIpcOptions): {
  options: McpIpcOptions
  AGENT_DIR: string
  connectorSetups: ConnectorSetupTracker
  connectorCatalog: (forceRefresh?: boolean) => Promise<ReturnType<typeof listConnectorCatalog>>
  localConnectorJobs: ReturnType<typeof createLocalConnectorJobs>
} {
  const AGENT_DIR = options.workspace.agentDir
  const app = { getVersion: options.lifecycle.getAppVersion }
  const sendToAllWindows = options.lifecycle.sendToAllWindows
  const loadPackageRegistries = options.packages.loadPackageRegistries

  const connectorSetups = new ConnectorSetupTracker(
    (progress) => sendToAllWindows(IPC.mcp.connectorSetupChanged, progress),
    undefined,
    { path: join(AGENT_DIR, 'state', 'connector-setup.json') }
  )
  const connectorCatalog = async (
    forceRefresh = false
  ): Promise<ReturnType<typeof listConnectorCatalog>> =>
    listConnectorCatalog({
      agentDir: AGENT_DIR,
      appVersion: app.getVersion(),
      runtimeRoot: getRuntimeRoot(),
      registries: (await loadPackageRegistries('mcp', forceRefresh)).registries
    }).map((connector) => ({ ...connector, setup: connectorSetups.get(connector.id) }))
  const localConnectorJobs = createLocalConnectorJobs({
    tracker: connectorSetups,
    agentDir: AGENT_DIR,
    runtimeRoot: getRuntimeRoot(),
    probe: (request) => getPhiEngine().mcp.configuredStdioTools(request),
    cancelProbe: (requestKey) => getPhiEngine().mcp.cancelConfiguredStdioTools({ requestKey }),
    applyEnabled: (name) => getPhiEngine().mcp.applyConnectorEnabled({ name }),
    onEvent: (event, metadata) =>
      writeAppLog({ event: `mcp_local_connector_add_${event}`, metadata })
  })

  return { options, AGENT_DIR, connectorSetups, connectorCatalog, localConnectorJobs }
}

type McpIpcContext = ReturnType<typeof createMcpIpcContext>

async function prepareStdioEnvironmentForContext(
  context: McpIpcContext,
  id: string,
  report: ConnectorSetupReporter
): Promise<{ envId: string }> {
  report('environment')
  const action = connectorEnvironmentBuildAction(id, { agentDir: context.AGENT_DIR })
  const handle = await context.options.packages.environmentBuilds.start(
    action.descriptor,
    action.options
  )
  const refreshed = refreshPersistedManagedStdioServers({
    agentDir: context.AGENT_DIR,
    runtimeRoot: getRuntimeRoot()
  })
  const failure = refreshed.failures.find((entry) => entry.name === id)
  if (failure) throw failure.error
  return { envId: handle.envId }
}

async function probeStdioToolsForContext(
  context: McpIpcContext,
  id: string,
  report: ConnectorSetupReporter
): Promise<string[]> {
  const entry = readMcpServerEntry(id, context.AGENT_DIR)
  if (!entry || entry.phiPackage !== id) throw new Error('Install this local Connector first')
  report('starting')
  return getPhiEngine().mcp.configuredStdioTools({
    name: id,
    entry,
    environment: { agentDir: context.AGENT_DIR, root: getRuntimeRoot() }
  })
}

async function listMcpServersForContext(
  context: McpIpcContext,
  cwd?: string
): Promise<Awaited<ReturnType<typeof listMcpServers>>> {
  const { options } = context
  if (!options.workspace.isRemoteResourceScope(cwd)) {
    return listMcpServers(cwd ?? options.workspace.getCurrentCwd())
  }
  const remoteContext = resolveRemoteMcpProjectContext(
    cwd,
    options.workspace.resolveRemoteProjectContext
  )
  const [globalServers, projectCatalog] = await Promise.all([
    listGlobalMcpServers(),
    loadRemoteProjectMcpCatalog(remoteContext)
  ])
  return [...globalServers, ...projectCatalog.summaries]
}

export function registerMcpIpc(options: McpIpcOptions): void {
  const context = createMcpIpcContext(options)
  registerMcpCatalogIpc(context)
  registerMcpInstallIpc(context)
  registerMcpEnvironmentIpc(context)
  registerMcpConnectorMutationIpc(context)
  registerMcpApiKeyIpc(context)
  registerMcpFeaturedAuthIpc(context)
  registerMcpCustomAuthIpc(context)
}

function registerMcpCatalogIpc(context: McpIpcContext): void {
  const { options, connectorCatalog } = context
  const ipcMain = options.ipcMain
  const invalidateAgentSession = options.lifecycle.invalidateAgentSession
  const remoteMcpProjectContext = (cwd?: string): RemoteProjectMcpContext =>
    resolveRemoteMcpProjectContext(cwd, options.workspace.resolveRemoteProjectContext)
  const listedMcpServers = (cwd?: string): ReturnType<typeof listMcpServersForContext> =>
    listMcpServersForContext(context, cwd)
  ipcMain.handle(IPC.mcp.listServers, async (_, cwd?: string) => {
    const servers = await listedMcpServers(cwd)
    return withConnectorMetadata(servers, await connectorCatalog())
  })
  ipcMain.handle(IPC.mcp.trustRemoteProject, async (_, input: unknown) => {
    const request = checkedRemoteMcpTrustMutation(input)
    await trustRemoteProjectMcp(remoteMcpProjectContext(request.cwd), {
      relativePath: request.relativePath,
      contentHash: request.contentHash,
      confirmedItemIds: request.confirmedItemIds
    })
    await invalidateAgentSession()
    return withConnectorMetadata(await listedMcpServers(request.cwd), await connectorCatalog())
  })
  ipcMain.handle(IPC.mcp.revokeRemoteProjectTrust, async (_, input: unknown) => {
    const request = checkedRemoteMcpTrustMutation(input)
    await revokeRemoteProjectMcpTrust(remoteMcpProjectContext(request.cwd), {
      relativePath: request.relativePath,
      contentHash: request.contentHash
    })
    await invalidateAgentSession()
    return withConnectorMetadata(await listedMcpServers(request.cwd), await connectorCatalog())
  })
  ipcMain.handle(IPC.mcp.listConnectorCatalog, async () => connectorCatalog(true))
}

function registerMcpInstallIpc(context: McpIpcContext): void {
  const { options, AGENT_DIR, connectorSetups, connectorCatalog } = context
  const ipcMain = options.ipcMain
  const invalidateAgentSession = options.lifecycle.invalidateAgentSession
  const officialContentSourceOptions = options.packages.officialContentSourceOptions
  const prepareStdioEnvironment = (
    id: string,
    report: ConnectorSetupReporter
  ): Promise<{ envId: string }> => prepareStdioEnvironmentForContext(context, id, report)
  const probeStdioTools = (id: string, report: ConnectorSetupReporter): Promise<string[]> =>
    probeStdioToolsForContext(context, id, report)
  ipcMain.handle(
    IPC.mcp.installConnector,
    async (_, id: unknown, version?: unknown, registryDir?: unknown) => {
      if (
        typeof id !== 'string' ||
        id.length === 0 ||
        (version !== undefined && typeof version !== 'string') ||
        (registryDir !== undefined && typeof registryDir !== 'string')
      ) {
        throw new Error('Invalid Connector installation request')
      }
      const connector = (await connectorCatalog()).find(
        (entry) =>
          entry.id === id &&
          (version === undefined || entry.version === version) &&
          (registryDir === undefined || entry.registryDir === registryDir)
      )
      if (!connector?.registryDir) throw new Error(`Connector ${id} was not found in the catalog`)
      if (connector.unavailableReason) throw new Error(connector.unavailableReason)
      const sourceRegistryDir = connector.registryDir
      return connectorSetups.run(
        connector.id,
        async (report) => {
          const wasConfigured = readMcpServerEntry(connector.id, AGENT_DIR) !== undefined
          let toolNames: string[] | undefined
          const sourceOptions = officialContentSourceOptions()
          const result = await installCatalogConnector(
            sourceRegistryDir,
            connector.id,
            connector.version,
            {
              ...sourceOptions,
              runtimeRoot: getRuntimeRoot(),
              onPhase: report,
              buildMcpEnvironment: (descriptor) => {
                report('environment')
                return sourceOptions.buildMcpEnvironment(descriptor)
              },
              verifyMcpStdio: async (request) => {
                report('starting')
                toolNames = await sourceOptions.verifyMcpStdio(request)
                return toolNames
              }
            }
          )
          if (!wasConfigured) {
            setEnabled(`mcp:${connector.id}`, true, { agentDir: AGENT_DIR })
            setMcpPackageEnabled(connector.id, true, AGENT_DIR)
          }
          try {
            if (connector.transport === 'stdio' && toolNames === undefined) {
              await prepareStdioEnvironment(connector.id, report)
              toolNames = await probeStdioTools(connector.id, report)
            }
          } finally {
            await invalidateAgentSession()
          }
          if (toolNames) report('ready', { toolNames })
          return result
        },
        connector.transport === 'stdio' ? 'ready' : 'installed'
      )
    }
  )
}

function registerMcpEnvironmentIpc(context: McpIpcContext): void {
  const { options, AGENT_DIR, connectorSetups } = context
  const ipcMain = options.ipcMain
  const invalidateAgentSession = options.lifecycle.invalidateAgentSession
  const prepareStdioEnvironment = (
    id: string,
    report: ConnectorSetupReporter
  ): Promise<{ envId: string }> => prepareStdioEnvironmentForContext(context, id, report)
  const probeStdioTools = (id: string, report: ConnectorSetupReporter): Promise<string[]> =>
    probeStdioToolsForContext(context, id, report)
  ipcMain.handle(IPC.mcp.uninstallConnector, async (_, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('Invalid Connector ID')
    return connectorSetups.run(
      id,
      async () => {
        const result = uninstallCatalogConnector(id, {
          agentDir: AGENT_DIR,
          runtimeRoot: getRuntimeRoot()
        })
        setEnabled(`mcp:${id}`, null, { agentDir: AGENT_DIR })
        await invalidateAgentSession()
        return result
      },
      'removed'
    )
  })
  ipcMain.handle(IPC.mcp.buildConnectorEnvironment, async (_, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('Invalid Connector ID')
    return connectorSetups.run(id, async (report) => {
      let environment: { envId: string }
      let toolNames: string[]
      try {
        environment = await prepareStdioEnvironment(id, report)
        toolNames = await probeStdioTools(id, report)
      } finally {
        await invalidateAgentSession()
      }
      report('ready', { toolNames })
      return environment
    })
  })
}

function registerMcpConnectorMutationIpc(context: McpIpcContext): void {
  const { options, AGENT_DIR, connectorCatalog, localConnectorJobs } = context
  const ipcMain = options.ipcMain
  ipcMain.handle(
    IPC.mcp.addRemoteConnector,
    async (_, name: string, url: string, options?: RemoteMcpConnectorOptions) => {
      addRemoteMcpConnector(name, url, undefined, options)
      await syncFeaturedMcpApiKeySessions(name)
    }
  )
  ipcMain.handle(IPC.mcp.addLocalConnector, async (_, raw: unknown) => {
    const catalogIds = (await connectorCatalog()).map((connector) => connector.id)
    const request = validateLocalConnectorRequest(raw, { catalogIds })
    // The MCP client only loads under the omp worker's Bun runtime, so probe through the bridge
    // exactly like the package installer does; the Electron main process cannot import it.
    const result = await addLocalMcpConnector(request, {
      agentDir: AGENT_DIR,
      catalogIds,
      probe: (probeRequest) => getPhiEngine().mcp.configuredStdioTools(probeRequest)
    })
    await getPhiEngine().mcp.applyConnectorEnabled({ name: request.name })
    return result
  })
  ipcMain.handle(IPC.mcp.startLocalConnectorAdd, async (_, raw: unknown) => {
    const catalogIds = (await connectorCatalog()).map((connector) => connector.id)
    const request = validateLocalConnectorRequest(raw, { catalogIds })
    return localConnectorJobs.startLocalConnectorAdd(request)
  })
  ipcMain.handle(IPC.mcp.cancelLocalConnectorAdd, async (_, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Invalid Connector name')
    await localConnectorJobs.cancelLocalConnectorAdd(validateName(name))
  })
  ipcMain.handle(IPC.mcp.retryLocalConnectorAdd, async (_, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Invalid Connector name')
    return localConnectorJobs.retryLocalConnectorAdd(validateName(name))
  })
  ipcMain.handle(IPC.mcp.listLocalConnectorJobs, async () =>
    localConnectorJobs.listLocalConnectorJobs()
  )
  ipcMain.handle(IPC.mcp.removeLocalConnector, async (_, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Invalid Connector name')
    const validatedName = validateName(name)
    await removeLocalMcpConnector(validatedName)
    await getPhiEngine().mcp.applyConnectorEnabled({ name: validatedName })
  })
  ipcMain.handle(IPC.mcp.listLocalRuntimes, async () => listLocalMcpRuntimes())
  ipcMain.handle(IPC.mcp.removeRemoteConnector, async (_, name: string, url: string) => {
    removeRemoteMcpConnector(name, url)
    if (API_KEY_CONNECTOR_IDS.some((id) => id === name && apiKeyConnector(id).url === url)) {
      clearFeaturedMcpApiKey(name)
      verifiedMcpApiKeys.delete(name)
    }
    await syncFeaturedMcpApiKeySessions(name)
  })
}

function registerMcpApiKeyIpc(context: McpIpcContext): void {
  const { options } = context
  const ipcMain = options.ipcMain
  ipcMain.handle(
    IPC.mcp.setConnectorEnabled,
    async (_, name: string, enabled: boolean, sourcePath?: string) => {
      if (typeof sourcePath === 'string' && sourcePath.startsWith('ssh://')) {
        throw new Error('Server project MCP enablement is managed by the server configuration file')
      }
      setMcpConnectorEnabled(
        name,
        Boolean(enabled),
        typeof sourcePath === 'string' ? sourcePath : undefined
      )
      try {
        await getPhiEngine().mcp.applyConnectorEnabled({ name })
      } catch (error) {
        if (!API_KEY_CONNECTOR_IDS.some((id) => id === name)) throw error
        writeAppLog({ event: 'mcp_api_key_session_sync_failed', metadata: { connectorId: name } })
        await getPhiEngine().stop()
        throw new Error(
          'Local changes were saved, but the running chat could not be synchronized and was stopped. Reopen the chat and try again.'
        )
      }
    }
  )
  ipcMain.handle(IPC.mcp.featuredApiKeyStatus, async (_, id: string) =>
    featuredMcpApiKeyVerifiedStatus(id)
  )
  ipcMain.handle(IPC.mcp.setFeaturedApiKey, async (_, id: string, key: string) => {
    apiKeyConnector(id)
    await validateFeaturedMcpApiKey(id, key)
    disableFeaturedApiKeyAutoDiscovery()
    setFeaturedMcpApiKey(id, key)
    verifiedMcpApiKeys.set(id, {
      digest: apiKeyDigest(key.trim()),
      expiresAt: verificationExpiresAt(id)
    })
    if (isFeaturedMcpApiKeyInstalled(id)) await syncFeaturedMcpApiKeySessions(id)
  })
  ipcMain.handle(IPC.mcp.clearFeaturedApiKey, async (_, id: string) => {
    clearFeaturedMcpApiKey(id)
    verifiedMcpApiKeys.delete(id)
    await syncFeaturedMcpApiKeySessions(id)
  })
}

function registerMcpFeaturedAuthIpc(context: McpIpcContext): void {
  const { options, connectorSetups, connectorCatalog } = context
  const ipcMain = options.ipcMain
  const probeStdioTools = (id: string, report: ConnectorSetupReporter): Promise<string[]> =>
    probeStdioToolsForContext(context, id, report)
  ipcMain.handle(IPC.mcp.featuredTools, async (_, id: string) => {
    if (typeof id !== 'string') throw new Error('Invalid Connector ID')
    const connector = (await connectorCatalog()).find((entry) => entry.id === id)
    if (!connector) throw new Error('This Connector was not found in the catalog')
    if (connector.transport === 'stdio') {
      return connectorSetups.run(id, async (report) => {
        const toolNames = await probeStdioTools(id, report)
        report('ready', { toolNames })
        return toolNames
      })
    }
    if (!connector.url) throw new Error('Invalid Connector service URL')
    return getPhiEngine().mcp.featuredTools({
      id,
      url: connector.url,
      auth: connector.auth
    })
  })
  ipcMain.handle(IPC.mcp.featuredAuthStatus, async (_, id: string) => {
    const connector = (await connectorCatalog()).find((entry) => entry.id === id)
    if (!connector?.url || !mcpOAuthAuthorizationOrigin(id, connector.url)) {
      throw new Error('This Connector does not support sign-in status checks')
    }
    return getPhiEngine().mcp.featuredAuthStatus({ id, url: connector.url })
  })
  ipcMain.handle(IPC.mcp.authorizeFeatured, async (_, id: string) => {
    const connector = (await connectorCatalog()).find((entry) => entry.id === id)
    if (!connector?.url || !mcpOAuthAuthorizationOrigin(id, connector.url)) {
      throw new Error('This Connector does not support OAuth authorization')
    }
    await getPhiEngine().mcp.authorizeFeatured({ id, url: connector.url })
  })
  ipcMain.handle(IPC.mcp.cancelFeaturedAuth, async (_, id: string) => {
    if (typeof id !== 'string' || !id) return
    await getPhiEngine().mcp.cancelFeaturedAuth({ id })
  })
}

function registerMcpCustomAuthIpc(context: McpIpcContext): void {
  const { options, AGENT_DIR } = context
  const ipcMain = options.ipcMain
  const pendingCustomMcpAuthorizations = options.customAuthorization.pending
  const customMcpAuthUrl = options.customAuthorization.parseUrl
  const customMcpConfigDigest = options.customAuthorization.configDigest
  ipcMain.handle(IPC.mcp.authorizeRemoteConnector, async (_, name: string) => {
    const connector = readCustomRemoteMcpConnector(name, AGENT_DIR)
    if (pendingCustomMcpAuthorizations.has(connector.name))
      throw new Error('Authorization is already in progress for this Connector')
    const pending: PendingCustomMcpAuthorization = {
      attemptId: randomUUID(),
      serverUrl: connector.url,
      configDigest: customMcpConfigDigest(connector),
      cancelled: false
    }
    // Register before discovery: cancel during preflight must prevent the later browser flow.
    pendingCustomMcpAuthorizations.set(connector.name, pending)
    let authorizationStarted = false
    try {
      const prepared = await getPhiEngine().mcp.prepareRemoteAuth({
        name: connector.name,
        attemptId: pending.attemptId
      })
      if (pending.cancelled) throw new Error('Authorization cancelled')
      const current = readCustomRemoteMcpConnector(connector.name, AGENT_DIR)
      if (
        !prepared ||
        prepared.serverUrl !== pending.serverUrl ||
        customMcpConfigDigest(current) !== pending.configDigest
      ) {
        throw new Error('Connector configuration changed. Authorize again.')
      }
      const authorizationUrl = customMcpAuthUrl(prepared.authorizationUrl)
      pending.authorizationOrigin = authorizationUrl.origin
      pending.authorizationPath = authorizationUrl.pathname
      authorizationStarted = true
      await getPhiEngine().mcp.authorizeRemote({
        name: connector.name,
        attemptId: pending.attemptId,
        serverUrl: pending.serverUrl
      })
    } finally {
      if (pendingCustomMcpAuthorizations.get(connector.name) === pending)
        pendingCustomMcpAuthorizations.delete(connector.name)
      if (!authorizationStarted) {
        await getPhiEngine()
          .mcp.cancelRemoteAuth({ name: connector.name, attemptId: pending.attemptId })
          .catch(() => undefined)
      }
    }
  })
  ipcMain.handle(IPC.mcp.cancelRemoteAuth, async (_, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Invalid Connector name')
    const key = name.trim()
    const pending = pendingCustomMcpAuthorizations.get(key)
    if (!pending) return
    pending.cancelled = true
    await getPhiEngine().mcp.cancelRemoteAuth({
      name: key,
      attemptId: pending.attemptId
    })
  })
}
