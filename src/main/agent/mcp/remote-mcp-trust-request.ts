// Validates renderer requests that confirm trust for a remote project's MCP config file.
// Does not apply the trust decision; remote-project-mcp-service owns that.
import { isRecord } from '../../../shared/guards'
import type { RemoteProjectMcpContext } from './remote-project-mcp-service'

export function remoteMcpProjectContext(
  cwd: string | undefined,
  resolveContext: (cwd?: string) => RemoteProjectMcpContext
): RemoteProjectMcpContext {
  return resolveContext(cwd)
}

export function checkedRemoteMcpTrustMutation(value: unknown): {
  cwd: string
  relativePath: string
  contentHash: string
  confirmedItemIds: string[]
} {
  if (!isRecord(value)) throw new Error('远程项目 MCP 信任请求无效')
  if (
    Object.keys(value).some(
      (key) =>
        key !== 'cwd' &&
        key !== 'relativePath' &&
        key !== 'contentHash' &&
        key !== 'confirmedItemIds'
    ) ||
    typeof value.cwd !== 'string' ||
    typeof value.relativePath !== 'string' ||
    !/^(?:\.phi\/mcp\.json|\.mcp\.json|\.omp\/mcp\.json|\.pi\/mcp\.json)$/u.test(
      value.relativePath
    ) ||
    typeof value.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.contentHash) ||
    !Array.isArray(value.confirmedItemIds) ||
    value.confirmedItemIds.length > 1024 ||
    !value.confirmedItemIds.every(
      (item) => typeof item === 'string' && item.length > 0 && item.length <= 512
    )
  ) {
    throw new Error('远程项目 MCP 信任请求无效')
  }
  return value as {
    cwd: string
    relativePath: string
    contentHash: string
    confirmedItemIds: string[]
  }
}
