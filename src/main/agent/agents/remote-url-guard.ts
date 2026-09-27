import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

const URL_ROUTING_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'ast_edit',
  'ast_grep',
  'bash',
  'powershell'
])

/** Raw SDK ssh:// URLs have no Phi project/host authorization yet. */
export function remoteUrlGuardDecision(
  toolName: string,
  input: unknown
): {
  allowed: boolean
  reason?: string
} {
  if (!URL_ROUTING_TOOLS.has(toolName) || typeof input !== 'object' || input === null) {
    return { allowed: true }
  }
  const record = input as Record<string, unknown>
  const pathLike = [record.path, record.file_path, record.paths, record.cwd]
  if (toolName === 'bash' || toolName === 'powershell') pathLike.push(record.command)
  if (toolName === 'edit' || toolName === 'ast_edit') pathLike.push(record.edits)
  const hasRemoteUrl = pathLike.some((value) => {
    try {
      return /ssh:\/\//i.test(typeof value === 'string' ? value : JSON.stringify(value))
    } catch {
      return false
    }
  })
  return hasRemoteUrl
    ? { allowed: false, reason: '未经项目授权的 ssh:// 路径不能直接使用；请在 Phi 中配置远程项目' }
    : { allowed: true }
}

export function createRemoteUrlGuardExtension(): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const decision = remoteUrlGuardDecision(event.toolName, event.input)
      return decision.allowed ? undefined : { block: true, reason: decision.reason }
    })
  }
}
