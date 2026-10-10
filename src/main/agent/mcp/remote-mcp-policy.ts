import { isAbsolute, relative, resolve } from 'node:path'

export const REMOTE_MCP_PROJECT_DEPENDENCY_REASON =
  '该 MCP 依赖项目文件，需要在服务器运行，暂未支持。请改用远程 read/bash/skill_run，或等待服务器端 stdio MCP 支持；该操作没有回退到本机项目锚点。'

export const REMOTE_MCP_UNVERIFIED_REASON =
  '该 MCP 工具不是来自 Phi 应用级 mcp.json 的已验证注册，已拒绝。请在设置中启用全局 HTTPS 或仅调用外部 API 的 stdio 连接器；项目级 MCP 需等待服务器端支持。'

const HTTPS_REQUIRED_REASON = '远程项目只允许应用级 HTTPS MCP；请把连接器地址改为 HTTPS 后重试。'
const INVALID_CONFIG_REASON = '该应用级 MCP 配置没有有效的 HTTPS 或 stdio transport，已拒绝。'
const PROJECT_PLACEHOLDER =
  /(?:\$\{(?:workspace(?:Folder|Root)(?::[^}]*)?|project(?:Dir|Root)|cwd|PWD)\}|\$(?:PWD|CWD|PROJECT_(?:DIR|ROOT)|WORKSPACE_(?:FOLDER|ROOT))\b|%(?:PWD|CWD|PROJECT_(?:DIR|ROOT)|WORKSPACE_(?:FOLDER|ROOT))%|\{\{(?:workspace(?:Folder|Root)|project(?:Dir|Root)|cwd)\}\})/i

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function collectStrings(value: unknown, output: string[], seen = new Set<object>()): void {
  if (typeof value === 'string') {
    output.push(value)
    return
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    collectStrings(item, output, seen)
  }
}

function referencesAnchor(value: string, context: RemoteMcpContext): boolean {
  const normalizedValue = value.replaceAll('\\', '/')
  const normalizedAnchor = resolve(context.localProjectAnchor).replaceAll('\\', '/')
  if (normalizedValue.includes(normalizedAnchor)) return true
  if (normalizedValue.includes(`file://${normalizedAnchor}`)) return true
  const relativeAnchor = relative(context.agentDir, context.localProjectAnchor).replaceAll(
    '\\',
    '/'
  )
  return (
    relativeAnchor !== '' &&
    !relativeAnchor.startsWith('..') &&
    normalizedValue.includes(relativeAnchor)
  )
}

function hasProjectDependency(entry: Record<string, unknown>, context: RemoteMcpContext): boolean {
  const strings: string[] = []
  collectStrings(entry, strings)
  if (strings.some((value) => PROJECT_PLACEHOLDER.test(value))) return true
  if (strings.some((value) => referencesAnchor(value, context))) return true
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

function sanitizedServerName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z_]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'server'
  )
}

function blockedServerReason(toolName: string, state: RemoteMcpGuardState): string | undefined {
  const matches = [...state.blockedServerReasons.entries()].filter(([serverName]) =>
    toolName.startsWith(`mcp__${sanitizedServerName(serverName)}_`)
  )
  return matches.length === 1 ? matches[0]?.[1] : undefined
}

export function remoteMcpInputUsesLocalProject(input: unknown, context: RemoteMcpContext): boolean {
  const strings: string[] = []
  collectStrings(input, strings)
  return strings.some(
    (value) => PROJECT_PLACEHOLDER.test(value) || referencesAnchor(value, context)
  )
}

export function remoteMcpToolCallReason(
  toolName: string,
  input: unknown,
  source: string | undefined,
  state: RemoteMcpGuardState | undefined
): string | undefined {
  if (!state || source !== 'mcp' || !state.allowedToolNames.has(toolName)) {
    return (state && blockedServerReason(toolName, state)) || REMOTE_MCP_UNVERIFIED_REASON
  }
  return remoteMcpInputUsesLocalProject(input, state)
    ? REMOTE_MCP_PROJECT_DEPENDENCY_REASON
    : undefined
}
