import { type CreateAgentSessionResult } from '@oh-my-pi/pi-coding-agent'
import {
  authorizeFeaturedMcp,
  discoverCustomMcpOAuthEndpoints,
  listFeaturedMcpTools
} from '../mcp/featured-mcp-auth'
import {
  cancelConfiguredStdioMcpTools,
  listConfiguredStdioMcpTools
} from '../mcp/configured-stdio-tools'
import { MCPManager } from '../mcp/omp-mcp'
import { acquireEnvironmentLease, type EnvironmentLease } from '../../envs/leases'
import { getRuntimeRoot } from '../../envs/runtime'
import { readMcpConfig } from '../../mcp/package-config'
import { readManagedMarker } from '../../mcp/stdio-environment'
import {
  buildRemoteMcpGuardState,
  buildRemoteMcpProfilePolicy,
  prepareRemoteMcpServerEntry,
  type RemoteMcpProfilePolicy
} from '../../mcp/remote-mcp-policy'
import { mergeRemoteMcpPolicies } from '../../mcp/remote-project-mcp-runtime'
import {
  API_KEY_CONNECTOR_IDS,
  apiKeyConnector,
  featuredApiKeyMcpConfig,
  isFeaturedMcpApiKeyInstalled
} from '../../mcp-key-credentials'
import {
  isMcpConnectorUserDisabled,
  mcpOAuthAuthorizationOrigin,
  readCustomRemoteMcpConnector,
  readRemoteMcpOAuthCredentials,
  readMcpServerEntry
} from '../../mcp-connectors'
import { isRecord, stringValue } from './common'
import { requestHost } from './ipc'
import { getContext } from './runtime-context'
import {
  RemoteMcpAccess,
  SessionEntry,
  featuredAuthAbort,
  pendingCustomMcpAuth,
  sessions
} from './state'

export async function syncFeaturedApiKeysForSession(
  result: CreateAgentSessionResult,
  agentDir: string,
  id?: string,
  remoteMcpAccess?: RemoteMcpAccess
): Promise<void> {
  const manager = result.mcpManager
  if (!manager) return
  const ids = id ? [id] : API_KEY_CONNECTOR_IDS
  for (const connectorId of ids) {
    const connector = apiKeyConnector(connectorId)
    const existing = manager.getServerConfig(connectorId)
    // Never replace an unrelated project server that happens to use the same name.
    if (existing && (existing.type !== 'http' || existing.url !== connector.url)) continue
    if (existing) await manager.disconnectServer(connectorId)
    if (!isFeaturedMcpApiKeyInstalled(connectorId, agentDir)) continue
    if (isMcpConnectorUserDisabled(connectorId, agentDir)) continue
    const key = await requestHost('mcp.featuredApiKey', { id: connectorId })
    if (typeof key !== 'string' || !key) continue
    try {
      await manager.connectServers({ [connectorId]: featuredApiKeyMcpConfig(connectorId, key) }, {})
    } catch {
      // A failed connector must not prevent the ordinary chat session from starting.
    }
  }
  if (remoteMcpAccess) refreshRemoteMcpAccess(remoteMcpAccess, agentDir, manager.getTools())
  await result.session.refreshMCPTools(manager.getTools())
}

export function refreshRemoteMcpAccess(
  access: RemoteMcpAccess,
  agentDir: string,
  tools: ReturnType<MCPManager['getTools']>
): RemoteMcpProfilePolicy {
  access.state = undefined
  const policy = mergeRemoteMcpPolicies(
    buildRemoteMcpProfilePolicy(readMcpConfig(agentDir), {
      agentDir,
      localProjectAnchor: access.localProjectAnchor
    }),
    access.projectPolicy
  )
  access.state = buildRemoteMcpGuardState(policy, tools, {
    agentDir,
    localProjectAnchor: access.localProjectAnchor
  })
  return policy
}

export type LiveMcpManager = {
  disconnectServer(name: string): Promise<void>
  connectServers(
    configs: Record<string, Record<string, unknown>>,
    sources: Record<string, unknown>
  ): Promise<unknown>
  getTools(): ReturnType<MCPManager['getTools']>
}

export function liveMcpManager(result: CreateAgentSessionResult): LiveMcpManager | undefined {
  const manager = result.mcpManager as Partial<LiveMcpManager> | undefined
  if (
    !manager ||
    typeof manager.disconnectServer !== 'function' ||
    typeof manager.connectServers !== 'function' ||
    typeof manager.getTools !== 'function'
  ) {
    return undefined
  }
  return manager as LiveMcpManager
}

export function injectableServerConfig(
  entry: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (typeof entry.command === 'string') {
    return {
      type: 'stdio',
      command: entry.command,
      ...(Array.isArray(entry.args) ? { args: entry.args } : {}),
      ...(isRecord(entry.env) ? { env: entry.env } : {}),
      ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
      ...(typeof entry.timeout === 'number' ? { timeout: entry.timeout } : {}),
      ...(entry.requestIdFormat === 'number' || entry.requestIdFormat === 'string'
        ? { requestIdFormat: entry.requestIdFormat }
        : {}),
      enabled: true
    }
  }
  if (typeof entry.url !== 'string') return undefined
  return {
    type: entry.type === 'sse' ? 'sse' : 'http',
    url: entry.url,
    enabled: true,
    timeout: typeof entry.timeout === 'number' ? entry.timeout : 10_000
  }
}

export async function disconnectSessionMcpServer(
  session: SessionEntry,
  name: string,
  manager: LiveMcpManager
): Promise<void> {
  const transports = session.ownedStdioTransports?.get(name)
  if (transports) transports.stopping = true
  try {
    await manager.disconnectServer(name)
  } finally {
    await transports?.drain()
  }
  session.mcpLeases?.get(name)?.release()
  session.mcpLeases?.delete(name)
  session.ownedStdioTransports?.delete(name)
}

export function connectorConfigForSession(
  session: SessionEntry,
  entry: Record<string, unknown>,
  manager: LiveMcpManager
): { config?: Record<string, unknown>; reason?: string } {
  const access = session.remoteMcpAccess
  if (!access) return { config: injectableServerConfig(entry) }
  refreshRemoteMcpAccess(access, session.agentDir, manager.getTools())
  const decision = prepareRemoteMcpServerEntry(entry, {
    agentDir: session.agentDir,
    localProjectAnchor: access.localProjectAnchor
  })
  return decision.allowed
    ? { config: injectableServerConfig(decision.entry) }
    : { reason: decision.reason }
}

export async function applyConnectorEnabledForSession(
  session: SessionEntry,
  name: string
): Promise<void> {
  const { result, agentDir } = session
  if (session.disposing) return
  if (API_KEY_CONNECTOR_IDS.includes(name as (typeof API_KEY_CONNECTOR_IDS)[number])) {
    await syncFeaturedApiKeysForSession(result, agentDir, name, session.remoteMcpAccess)
    return
  }
  const manager = liveMcpManager(result)
  if (!manager) return
  if (session.remoteMcpAccess?.projectPolicy?.allowedServerNames.has(name)) {
    refreshRemoteMcpAccess(session.remoteMcpAccess, agentDir, manager.getTools())
    await result.session.refreshMCPTools(manager.getTools() as never)
    return
  }
  const entry = readMcpServerEntry(name, agentDir)
  const disabled = isMcpConnectorUserDisabled(name, agentDir) || entry?.enabled === false
  if (disabled || !entry) {
    await disconnectSessionMcpServer(session, name, manager)
  } else {
    const prepared = connectorConfigForSession(session, entry, manager)
    if (prepared.reason) {
      await disconnectSessionMcpServer(session, name, manager)
      await result.session.refreshMCPTools(manager.getTools() as never)
      throw new Error(`${name}：${prepared.reason}`)
    }
    const config = prepared.config
    if (config) {
      const marker = readManagedMarker(entry)
      if (!marker && entry.phiManaged !== undefined)
        throw new Error('MCP managed environment metadata is invalid')
      const existing = session.mcpLeases?.get(name)
      // A running session keeps its original installation across package upgrades.
      if (existing && marker && existing.envId !== marker.envId) return
      let lease: EnvironmentLease | undefined
      try {
        if (marker && !existing) {
          if (marker.pending) throw new Error('MCP environment is not ready')
          lease = await acquireEnvironmentLease({
            root: getRuntimeRoot(agentDir),
            envId: marker.envId
          })
        }
        if (session.disposing) return
        await manager.connectServers({ [name]: config }, {})
        if (session.disposing) {
          await manager.disconnectServer(name)
          return
        }
        if (lease) {
          session.mcpLeases ??= new Map()
          session.mcpLeases.set(name, lease)
          lease = undefined
        }
      } finally {
        if (lease) {
          const transports = session.ownedStdioTransports?.get(name)
          if (transports) transports.stopping = true
          try {
            await manager.disconnectServer(name)
          } finally {
            await transports?.drain()
          }
          session.ownedStdioTransports?.delete(name)
          lease.release()
        }
      }
    }
  }
  if (session.remoteMcpAccess) {
    refreshRemoteMcpAccess(session.remoteMcpAccess, agentDir, manager.getTools())
  }
  await result.session.refreshMCPTools(manager.getTools() as never)
}

export async function applyConnectorEnabled(name: string): Promise<void> {
  await Promise.all(
    [...sessions.values()].map((entry) => applyConnectorEnabledForSession(entry, name))
  )
}

export async function syncFeaturedApiKeys(id?: string): Promise<void> {
  if (id && !API_KEY_CONNECTOR_IDS.includes(id as (typeof API_KEY_CONNECTOR_IDS)[number])) return
  await Promise.all(
    [...sessions.values()].map((entry) =>
      syncFeaturedApiKeysForSession(entry.result, entry.agentDir, id, entry.remoteMcpAccess)
    )
  )
}

export async function handleMcpRequest(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'mcp.configuredStdioTools':
      return listConfiguredStdioMcpTools(params)
    case 'mcp.cancelConfiguredStdioTools':
      return cancelConfiguredStdioMcpTools(params)
    case 'mcp.featuredTools': {
      const record = isRecord(params) ? params : {}
      const id = stringValue(record.id)
      const url = stringValue(record.url)
      const auth = stringValue(record.auth)
      if (!id || !url.startsWith('https://') || !['none', 'oauth', 'header'].includes(auth)) {
        throw new Error('该连接器需要授权，暂无法读取实际工具列表')
      }
      if (auth === 'oauth' && !mcpOAuthAuthorizationOrigin(id, url)) {
        throw new Error('该连接器尚不支持登录状态查询')
      }
      const context = auth === 'oauth' ? await getContext() : undefined
      if (context && !context.auth.hasMcpOAuth(url)) {
        throw new Error(`请先授权登录 ${id}`)
      }
      const apiKey = auth === 'header' ? await requestHost('mcp.featuredApiKey', { id }) : undefined
      if (auth === 'header' && (typeof apiKey !== 'string' || !apiKey)) {
        throw new Error(`请先保存 ${id} API key 并添加连接器`)
      }
      return listFeaturedMcpTools(
        id,
        url,
        context?.authStorage,
        typeof apiKey === 'string' ? apiKey : undefined
      )
    }
    case 'mcp.syncFeaturedApiKeys': {
      const id = isRecord(params) ? stringValue(params.id) : ''
      await syncFeaturedApiKeys(id || undefined)
      return undefined
    }
    case 'mcp.applyConnectorEnabled': {
      const name = isRecord(params) ? stringValue(params.name) : ''
      if (!name) return undefined
      await applyConnectorEnabled(name)
      return undefined
    }
    case 'mcp.prepareRemoteAuth': {
      const record = isRecord(params) ? params : {}
      const connector = readCustomRemoteMcpConnector(stringValue(record.name))
      const attemptId = stringValue(record.attemptId)
      if (!attemptId || attemptId.length > 100) throw new Error('连接器授权请求无效')
      if (pendingCustomMcpAuth.has(connector.name)) throw new Error('该连接器正在授权')
      const pending = {
        attemptId,
        connector,
        cancel: new AbortController(),
        endpoints: undefined as
          Awaited<ReturnType<typeof discoverCustomMcpOAuthEndpoints>> | undefined
      }
      pendingCustomMcpAuth.set(connector.name, pending)
      try {
        pending.endpoints = await discoverCustomMcpOAuthEndpoints(
          connector.url,
          pending.cancel.signal
        )
        return { serverUrl: connector.url, authorizationUrl: pending.endpoints.authorizationUrl }
      } catch (error) {
        if (pendingCustomMcpAuth.get(connector.name) === pending)
          pendingCustomMcpAuth.delete(connector.name)
        throw error
      }
    }
    case 'mcp.cancelRemoteAuth': {
      const record = isRecord(params) ? params : {}
      const name = stringValue(record.name)
      const pending = pendingCustomMcpAuth.get(name)
      if (pending?.attemptId === stringValue(record.attemptId)) {
        pending.cancel.abort('授权已取消')
        pendingCustomMcpAuth.delete(name)
      }
      return undefined
    }
    case 'mcp.authorizeRemote': {
      const record = isRecord(params) ? params : {}
      const name = stringValue(record.name)
      const pending = pendingCustomMcpAuth.get(name)
      if (!pending?.endpoints || pending.attemptId !== stringValue(record.attemptId)) {
        throw new Error('连接器授权准备已失效，请重试')
      }
      try {
        const connector = readCustomRemoteMcpConnector(name)
        if (
          JSON.stringify(connector) !== JSON.stringify(pending.connector) ||
          connector.url !== record.serverUrl
        ) {
          throw new Error('连接器配置已变化，请重新授权')
        }
        if (pending.cancel.signal.aborted) throw new Error('授权已取消')
        const ctx = await getContext()
        await authorizeFeaturedMcp(
          connector.url,
          ctx.auth,
          (url) =>
            requestHost('mcp.openCustomAuthUrl', {
              name,
              attemptId: pending.attemptId,
              url
            }) as Promise<void>,
          pending.cancel.signal,
          connector.oauth,
          pending.endpoints,
          () => {
            if (
              JSON.stringify(readCustomRemoteMcpConnector(name)) !==
              JSON.stringify(pending.connector)
            ) {
              throw new Error('连接器配置已变化，请重新授权')
            }
          }
        )
      } catch (error) {
        const message =
          error instanceof Error ? error.message : typeof error === 'string' ? error : ''
        if (pending.cancel.signal.aborted || message.includes('授权已取消'))
          throw new Error('授权已取消')
        if (message.includes('授权已超时')) throw new Error('授权已超时')
        if (message === '连接器配置已变化，请重新授权') throw new Error(message)
        // Provider errors can echo submitted client credentials. Keep those in neither IPC nor logs.
        throw new Error('连接器授权失败，请检查客户端信息并重试')
      } finally {
        if (pendingCustomMcpAuth.get(name) === pending) pendingCustomMcpAuth.delete(name)
      }
      return undefined
    }
    case 'mcp.featuredAuthStatus': {
      const record = isRecord(params) ? params : {}
      const id = stringValue(record.id)
      const url = stringValue(record.url)
      if (!mcpOAuthAuthorizationOrigin(id, url)) {
        throw new Error('该连接器尚不支持登录状态查询')
      }
      const { auth } = await getContext()
      return auth.hasMcpOAuthToken(url)
    }
    case 'mcp.cancelFeaturedAuth': {
      const id = isRecord(params) ? stringValue(params.id) : ''
      featuredAuthAbort.get(id)?.abort('授权已取消')
      return undefined
    }
    case 'mcp.authorizeFeatured': {
      const record = isRecord(params) ? params : {}
      const id = stringValue(record.id)
      const url = stringValue(record.url)
      if (!mcpOAuthAuthorizationOrigin(id, url)) {
        throw new Error('该连接器尚不支持 OAuth 授权')
      }
      const ctx = await getContext()
      const cancel = new AbortController()
      featuredAuthAbort.set(id, cancel)
      try {
        await authorizeFeaturedMcp(
          url,
          ctx.auth,
          (url) => requestHost('mcp.openAuthUrl', { id, url }) as Promise<void>,
          cancel.signal,
          readRemoteMcpOAuthCredentials(id, url, ctx.agentDir || undefined)
        )
      } finally {
        featuredAuthAbort.delete(id)
      }
      return undefined
    }
    default:
      throw new Error(`Unknown OMP worker method: ${method}`)
  }
}
