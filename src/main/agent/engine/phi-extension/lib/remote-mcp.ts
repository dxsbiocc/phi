import { relative, resolve } from 'node:path'

export interface PhiRemoteMcpGuardState {
  allowedToolNames: ReadonlySet<string>
  blockedServerReasons: ReadonlyMap<string, string>
  agentDir: string
  localProjectAnchor: string
}

export const REMOTE_MCP_PROJECT_DEPENDENCY_REASON =
  '该 MCP 依赖项目文件，需要在服务器运行，暂未支持。请改用远程 read/bash/skill_run，或等待服务器端 stdio MCP 支持；该操作没有回退到本机项目锚点。'

export const REMOTE_MCP_UNVERIFIED_REASON =
  '该 MCP 工具不是来自 Phi 应用级 mcp.json 的已验证注册，已拒绝。请在设置中启用全局 HTTPS 或仅调用外部 API 的 stdio 连接器；项目级 MCP 需等待服务器端支持。'

const PROJECT_PLACEHOLDER =
  /(?:\$\{(?:workspace(?:Folder|Root)(?::[^}]*)?|project(?:Dir|Root)|cwd|PWD)\}|\$(?:PWD|CWD|PROJECT_(?:DIR|ROOT)|WORKSPACE_(?:FOLDER|ROOT))\b|%(?:PWD|CWD|PROJECT_(?:DIR|ROOT)|WORKSPACE_(?:FOLDER|ROOT))%|\{\{(?:workspace(?:Folder|Root)|project(?:Dir|Root)|cwd)\}\})/i

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

function referencesAnchor(
  value: string,
  context: { agentDir: string; localProjectAnchor: string }
): boolean {
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

function sanitizedServerName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z_]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'server'
  )
}

function blockedServerReason(toolName: string, state: PhiRemoteMcpGuardState): string | undefined {
  const matches = [...state.blockedServerReasons.entries()].filter(([serverName]) =>
    toolName.startsWith(`mcp__${sanitizedServerName(serverName)}_`)
  )
  return matches.length === 1 ? matches[0]?.[1] : undefined
}

export function remoteMcpInputUsesLocalProject(
  input: unknown,
  context: { agentDir: string; localProjectAnchor: string }
): boolean {
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
  state: PhiRemoteMcpGuardState | undefined
): string | undefined {
  if (!state || source !== 'mcp' || !state.allowedToolNames.has(toolName)) {
    return (state && blockedServerReason(toolName, state)) || REMOTE_MCP_UNVERIFIED_REASON
  }
  return remoteMcpInputUsesLocalProject(input, state)
    ? REMOTE_MCP_PROJECT_DEPENDENCY_REASON
    : undefined
}
