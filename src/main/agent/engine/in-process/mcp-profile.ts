import { resolve } from 'node:path'
import { Settings } from '@oh-my-pi/pi-coding-agent'
import { AuthStorage } from '@oh-my-pi/pi-ai'
import { createPhiSettings } from './settings'
import { loadAllMCPConfigs, MCPManager } from '../mcp/omp-mcp'
import { OwnedStdioTransportScope } from '../mcp/owned-stdio-transports'
import { acquireEnvironmentLease, type EnvironmentLease } from '../../envs/leases'
import { getRuntimeRoot } from '../../envs/runtime'
import { readMcpConfig } from '../../mcp/package-config'
import { readManagedMarker } from '../../mcp/stdio-environment'
import {
  loadRemoteApplicationMcp,
  remoteMcpLoadPlan,
  type McpSnapshotLike,
  type RemoteMcpProfilePolicy
} from '../../mcp/remote-mcp-policy'
import {
  mergeRemoteProjectMcpSnapshot,
  remoteProjectMcpPolicy,
  remoteProjectMcpRuntimeServersValue
} from '../../mcp/remote-project-mcp-runtime'
import { isRecord } from './common'

export async function leasedProfileMcpManager(
  agentDir: string,
  projectCwd: string,
  settings: Settings,
  authStorage: AuthStorage,
  remoteProjectAnchor?: string,
  remoteProjectMcpServers: ReturnType<typeof remoteProjectMcpRuntimeServersValue> = []
): Promise<{
  manager: MCPManager
  leases: Map<string, EnvironmentLease>
  transports: Map<string, OwnedStdioTransportScope>
  remotePolicy?: RemoteMcpProfilePolicy
  projectPolicy?: RemoteMcpProfilePolicy
}> {
  const profile = readMcpConfig(agentDir)
  const phiSettings = createPhiSettings(settings)
  const mcpSettings = phiSettings.mcp.read()
  const extensionSettings = phiSettings.extensions.read()
  const plan = remoteMcpLoadPlan({
    projectCwd,
    agentDir,
    enableProjectConfig: mcpSettings.enableProjectConfig,
    remote: remoteProjectAnchor !== undefined
  })
  const discoveryOptions = {
    filterExa: true,
    extensionRoots: {
      explicit: [],
      mode: 'merge' as const,
      configured: extensionSettings.configured,
      configuredLevel: extensionSettings.sourceLevel
    }
  }
  let snapshot: Awaited<ReturnType<typeof loadAllMCPConfigs>>
  let remotePolicy: RemoteMcpProfilePolicy | undefined
  if (plan.globalOnly && remoteProjectAnchor) {
    const prepared = await loadRemoteApplicationMcp({
      agentDir,
      localProjectAnchor: remoteProjectAnchor,
      profile,
      options: discoveryOptions,
      load: async (loadCwd, options) =>
        (await loadAllMCPConfigs(
          loadCwd,
          options as Parameters<typeof loadAllMCPConfigs>[1]
        )) as unknown as McpSnapshotLike
    })
    const merged = mergeRemoteProjectMcpSnapshot(
      prepared.snapshot,
      prepared.policy,
      remoteProjectMcpServers
    )
    snapshot = merged.snapshot as unknown as Awaited<ReturnType<typeof loadAllMCPConfigs>>
    remotePolicy = merged.policy
  } else {
    snapshot = await loadAllMCPConfigs(plan.cwd, {
      ...discoveryOptions,
      enableProjectConfig: plan.enableProjectConfig
    })
  }
  const leases = new Map<string, EnvironmentLease>()
  try {
    for (const [name, config] of Object.entries(snapshot.configs)) {
      if (
        config.enabled === false ||
        resolve(snapshot.sources[name]?.path ?? '') !== resolve(agentDir, 'mcp.json')
      )
        continue
      const entry = profile.mcpServers?.[name]
      if (!isRecord(entry))
        throw new Error(`MCP profile changed while preparing ${name}; retry session creation`)
      const marker = readManagedMarker(entry)
      if (!marker) {
        if (entry.phiManaged !== undefined)
          throw new Error(`MCP managed environment metadata for ${name} is invalid`)
        continue
      }
      if (marker.pending) throw new Error(`MCP environment for ${name} is not ready`)
      if (
        config.type !== 'stdio' ||
        config.command !== entry.command ||
        JSON.stringify(config.args ?? []) !== JSON.stringify(entry.args ?? []) ||
        JSON.stringify(config.env ?? {}) !== JSON.stringify(entry.env ?? {}) ||
        config.cwd !== entry.cwd
      ) {
        throw new Error(`MCP profile changed while preparing ${name}; retry session creation`)
      }
      leases.set(
        name,
        await acquireEnvironmentLease({ root: getRuntimeRoot(agentDir), envId: marker.envId })
      )
    }
    const manager = new MCPManager(plan.cwd, null, async () => snapshot)
    const transports = trackOwnedStdioTransports(manager)
    manager.setAuthStorage(authStorage)
    if (mcpSettings.notifications) manager.setNotificationsEnabled(true)
    const projectPolicy = remoteProjectMcpPolicy(remoteProjectMcpServers)
    return {
      manager,
      leases,
      transports,
      ...(remotePolicy ? { remotePolicy } : {}),
      ...(projectPolicy ? { projectPolicy } : {})
    }
  } catch (error) {
    for (const lease of leases.values()) lease.release()
    throw error
  }
}

export function trackOwnedStdioTransports(
  manager: MCPManager
): Map<string, OwnedStdioTransportScope> {
  const scopes = new Map<string, OwnedStdioTransportScope>()
  const connect = manager.connectServers.bind(manager)
  manager.connectServers = async (...args) => {
    if (!Object.keys(args[0]).length) return connect(...args)
    const results = await Promise.all(
      Object.entries(args[0]).map(([name, config]) => {
        const single = (): ReturnType<MCPManager['connectServers']> =>
          connect({ [name]: config }, args[1][name] ? { [name]: args[1][name] } : {}, args[2])
        if (config.type !== 'stdio') return single()
        let scope = scopes.get(name)
        if (!scope) {
          scope = new OwnedStdioTransportScope()
          scopes.set(name, scope)
        }
        return scope.run(single)
      })
    )
    return {
      tools: manager.getTools(),
      errors: new Map(results.flatMap((result) => [...result.errors])),
      connectedServers: [...new Set(results.flatMap((result) => result.connectedServers))],
      exaApiKeys: results.flatMap((result) => result.exaApiKeys)
    }
  }
  const reconnect = manager.reconnectServer.bind(manager)
  manager.reconnectServer = (...args) => {
    const scope = scopes.get(args[0])
    if (scope?.stopping) return Promise.resolve(null)
    return scope ? scope.run(() => reconnect(...args)) : reconnect(...args)
  }
  return scopes
}

export async function disconnectLeasedMcpManager(
  manager: MCPManager | undefined,
  scopes?: Map<string, OwnedStdioTransportScope>
): Promise<void> {
  for (const scope of scopes?.values() ?? []) scope.stopping = true
  try {
    await manager?.disconnectAll()
  } finally {
    await Promise.all([...(scopes?.values() ?? [])].map((scope) => scope.drain()))
  }
}
