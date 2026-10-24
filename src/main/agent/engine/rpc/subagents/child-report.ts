import type { RpcConnection } from '../connection'
import { withRemoteSignal } from '../history-pager'
import type { RpcChildRunSnapshot } from './types'

export async function readVerifiedChildReport(
  connection: RpcConnection,
  status: (id: string) => Readonly<RpcChildRunSnapshot> | undefined,
  run: Readonly<RpcChildRunSnapshot>,
  lifetimeSignal: AbortSignal,
  signal?: AbortSignal
): Promise<string> {
  const known = status(run.id)
  if (!known || known.nativeId !== run.nativeId || known.completedAt === undefined)
    throw new Error('Child report is not owned by this generation')
  if (known.status !== 'completed') return ''
  const result = await withRemoteSignal(
    connection.request<{ messages: unknown[] }>({
      type: 'get_subagent_messages',
      subagentId: known.nativeId
    }),
    AbortSignal.any([lifetimeSignal, ...(signal ? [signal] : [])])
  )
  if (!Array.isArray(result.messages)) throw new Error('Child report is unavailable')
  return completedChildReport(result.messages)
}

/** A terminal report cannot fall back to a previous assistant/tool-call tail. */
export function completedChildReport(messages: readonly unknown[]): string {
  const value = messages.at(-1)
  if (!value || typeof value !== 'object' || !('role' in value) || value.role !== 'assistant')
    return ''
  if (!('content' in value) || !Array.isArray(value.content)) return ''
  if (
    'stopReason' in value &&
    value.stopReason !== undefined &&
    (typeof value.stopReason !== 'string' || !['stop', 'length'].includes(value.stopReason))
  )
    return ''
  if (value.content.some((part) => part && typeof part === 'object' && part.type === 'toolCall'))
    return ''
  return value.content
    .flatMap((part) =>
      part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
        ? [part.text]
        : []
    )
    .join('\n')
    .slice(0, 20000)
}
