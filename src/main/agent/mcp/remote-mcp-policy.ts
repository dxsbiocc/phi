import { isAbsolute, relative, resolve } from 'node:path'
import {
  REMOTE_MCP_PROJECT_DEPENDENCY_REASON,
  remoteMcpInputUsesLocalProject
} from '../engine/phi-extension'

import { isRecord } from '../../../shared/guards'
export {
  REMOTE_MCP_PROJECT_DEPENDENCY_REASON,
  REMOTE_MCP_UNVERIFIED_REASON,
  remoteMcpInputUsesLocalProject,
  remoteMcpToolCallReason
} from '../engine/phi-extension'

const HTTPS_REQUIRED_REASON =
  'Remote projects only allow application-level HTTPS MCP. Change the Connector URL to HTTPS and try again.'
const INVALID_CONFIG_REASON =
  'This application-level MCP configuration has no valid HTTPS or stdio transport and was rejected.'
export interface McpSourceLike {
  path?: unknown
  level?: unknown
  [key: string]: unknown
}

export interface McpSnapshotLike {
  configs: Record<string, Record<string, unknown>>
  sources: Record<string, McpSourceLike>
  exaApiKeys: string[]
}

export interface RemoteMcpContext {
  agentDir: string
  localProjectAnchor: string
}

export interface RemoteMcpLoadPlan {
  cwd: string
  enableProjectConfig: boolean
  globalOnly: boolean
}

export interface RemoteMcpProfilePolicy {
  allowedServerNames: ReadonlySet<string>
  blockedServerReasons: ReadonlyMap<string, string>
  preparedEntries: ReadonlyMap<string, Record<string, unknown>>
}

export interface RemoteMcpGuardState {
  allowedToolNames: ReadonlySet<string>
  blockedServerReasons: ReadonlyMap<string, string>
  agentDir: string
  localProjectAnchor: string
}

export type RemoteMcpServerDecision =
  { allowed: true; entry: Record<string, unknown> } | { allowed: false; reason: string }

type McpToolLike = { name?: unknown; mcpServerName?: unknown }

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function hasProjectDependency(entry: Record<string, unknown>, context: RemoteMcpContext): boolean {
  if (remoteMcpInputUsesLocalProject(entry, context)) return true
  const marker = isRecord(entry.phiManaged) ? entry.phiManaged : undefined
  return typeof marker?.projectDir === 'string' && marker.projectDir.length > 0
}

function httpsUrl(entry: Record<string, unknown>): boolean {
  if (typeof entry.url !== 'string') return false
  try {
    return new URL(entry.url).protocol === 'https:'
  } catch {
    return false
  }
}

function preparedStdioEntry(
  entry: Record<string, unknown>,
  context: RemoteMcpContext
): RemoteMcpServerDecision {
  if (hasProjectDependency(entry, context)) {
    return { allowed: false, reason: REMOTE_MCP_PROJECT_DEPENDENCY_REASON }
  }
  const configuredCwd = typeof entry.cwd === 'string' && entry.cwd ? entry.cwd : context.agentDir
  const cwd = isAbsolute(configuredCwd)
    ? resolve(configuredCwd)
    : resolve(context.agentDir, configuredCwd)
  if (isInside(context.localProjectAnchor, cwd)) {
    return { allowed: false, reason: REMOTE_MCP_PROJECT_DEPENDENCY_REASON }
  }
  const command = entry.command
  if (typeof command !== 'string' || command.length === 0) {
    return { allowed: false, reason: INVALID_CONFIG_REASON }
  }
  if (/^\.\.?[/\\]/.test(command) && isInside(context.localProjectAnchor, resolve(cwd, command))) {
    return { allowed: false, reason: REMOTE_MCP_PROJECT_DEPENDENCY_REASON }
  }
  return { allowed: true, entry: { ...entry, type: 'stdio', cwd } }
}

export function prepareRemoteMcpServerEntry(
  entry: unknown,
  context: RemoteMcpContext
): RemoteMcpServerDecision {
  if (!isRecord(entry)) return { allowed: false, reason: INVALID_CONFIG_REASON }
  if (typeof entry.command === 'string') return preparedStdioEntry(entry, context)
  if (entry.type === 'http' || entry.type === 'sse' || typeof entry.url === 'string') {
    return httpsUrl(entry)
      ? { allowed: true, entry: { ...entry } }
      : { allowed: false, reason: HTTPS_REQUIRED_REASON }
  }
  return { allowed: false, reason: INVALID_CONFIG_REASON }
}

export function remoteMcpLoadPlan(input: {
  projectCwd: string
  agentDir: string
  enableProjectConfig: boolean
  remote: boolean
}): RemoteMcpLoadPlan {
  return input.remote
    ? { cwd: input.agentDir, enableProjectConfig: false, globalOnly: true }
    : {
        cwd: input.projectCwd,
        enableProjectConfig: input.enableProjectConfig,
        globalOnly: false
      }
}

export function buildRemoteMcpProfilePolicy(
  profile: unknown,
  context: RemoteMcpContext
): RemoteMcpProfilePolicy {
  const servers = isRecord(profile) && isRecord(profile.mcpServers) ? profile.mcpServers : {}
  const allowed = new Set<string>()
  const blocked = new Map<string, string>()
  const prepared = new Map<string, Record<string, unknown>>()
  for (const [name, entry] of Object.entries(servers)) {
    const decision = prepareRemoteMcpServerEntry(entry, context)
    if (!decision.allowed) {
      blocked.set(name, decision.reason)
      continue
    }
    allowed.add(name)
    prepared.set(name, decision.entry)
  }
  return { allowedServerNames: allowed, blockedServerReasons: blocked, preparedEntries: prepared }
}

function exactApplicationSource(source: McpSourceLike | undefined, agentDir: string): boolean {
  return typeof source?.path === 'string' && resolve(source.path) === resolve(agentDir, 'mcp.json')
}

export function prepareRemoteMcpSnapshot(
  snapshot: McpSnapshotLike,
  profile: unknown,
  context: RemoteMcpContext
): { snapshot: McpSnapshotLike; policy: RemoteMcpProfilePolicy } {
  const basePolicy = buildRemoteMcpProfilePolicy(profile, context)
  const configs: Record<string, Record<string, unknown>> = {}
  const sources: Record<string, McpSourceLike> = {}
  const blocked = new Map(basePolicy.blockedServerReasons)
  const allowed = new Set(basePolicy.allowedServerNames)
  const prepared = new Map(basePolicy.preparedEntries)
  for (const [name, config] of Object.entries(snapshot.configs)) {
    if (!exactApplicationSource(snapshot.sources[name], context.agentDir) || !allowed.has(name))
      continue
    const decision = prepareRemoteMcpServerEntry(config, context)
    if (!decision.allowed) {
      allowed.delete(name)
      prepared.delete(name)
      blocked.set(name, decision.reason)
      continue
    }
    configs[name] = decision.entry
    sources[name] = snapshot.sources[name]
  }
  return {
    snapshot: { ...snapshot, configs, sources },
    policy: {
      allowedServerNames: allowed,
      blockedServerReasons: blocked,
      preparedEntries: prepared
    }
  }
}

export async function loadRemoteApplicationMcp(input: {
  agentDir: string
  localProjectAnchor: string
  profile: unknown
  options?: Record<string, unknown>
  load: (cwd: string, options: Record<string, unknown>) => Promise<McpSnapshotLike>
}): Promise<{ snapshot: McpSnapshotLike; policy: RemoteMcpProfilePolicy }> {
  const snapshot = await input.load(input.agentDir, {
    ...input.options,
    enableProjectConfig: false
  })
  return prepareRemoteMcpSnapshot(snapshot, input.profile, {
    agentDir: input.agentDir,
    localProjectAnchor: input.localProjectAnchor
  })
}

export function buildRemoteMcpGuardState(
  policy: RemoteMcpProfilePolicy,
  tools: readonly McpToolLike[],
  context: RemoteMcpContext
): RemoteMcpGuardState {
  const allowedToolNames = new Set<string>()
  for (const tool of tools) {
    if (
      typeof tool.name === 'string' &&
      tool.name.startsWith('mcp__') &&
      typeof tool.mcpServerName === 'string' &&
      policy.allowedServerNames.has(tool.mcpServerName)
    ) {
      allowedToolNames.add(tool.name)
    }
  }
  return {
    allowedToolNames,
    blockedServerReasons: policy.blockedServerReasons,
    ...context
  }
}
