import { randomUUID } from 'node:crypto'
import type { RpcConnection } from './connection'
import { withRemoteSignal } from './history-pager'
import {
  compactionPolicy,
  compactionRecord,
  RPC_COMPACTION_COMMAND,
  RPC_COMPACTION_DESCRIPTION,
  type RpcCompactionIdentity,
  type RpcCompactionPolicy,
  type RpcCompactionRequest,
  type RpcCompactionNotification
} from '../phi-extension/lib/rpc-compaction-control'

/** Private extension callback outcome, independent from the early slash-command completion. */
export async function requestRuntimeCompactionControl(options: {
  connection: RpcConnection
  identity: RpcCompactionIdentity
  policy: RpcCompactionPolicy
  operation: RpcCompactionRequest['operation']
  signal: AbortSignal
  assertCurrent(): void
}): Promise<RpcCompactionNotification> {
  const { connection, signal } = options
  const request: RpcCompactionRequest = {
    ...options.identity,
    requestId: randomUUID(),
    operation: options.operation,
    expectedPolicy: options.policy
  }
  let resolve!: (value: RpcCompactionNotification) => void, reject!: (error: unknown) => void
  const outcome = new Promise<RpcCompactionNotification>((yes, no) => {
    resolve = yes
    reject = no
  })
  void outcome.catch(() => undefined)
  let dispatched = false
  const off = connection.onEvent((frame) => {
    if (dispatched && frame.type === 'agent_start')
      reject(new Error('Compaction control unexpectedly invoked a main turn'))
    if (
      dispatched &&
      frame.type === 'extension_error' &&
      frame.extensionPath === `command:${RPC_COMPACTION_COMMAND}`
    )
      reject(new Error('Owned compaction command failed'))
    if (
      frame.type !== 'extension_ui_request' ||
      frame.method !== 'notify' ||
      typeof frame.message !== 'string'
    )
      return
    let raw: unknown
    try {
      raw = JSON.parse(frame.message)
    } catch {
      return
    }
    if (
      !compactionRecord(raw) ||
      raw.type !== 'phi_rpc_compaction_control' ||
      raw.requestId !== request.requestId
    )
      return
    try {
      options.assertCurrent()
      if (
        frame.notifyType !== 'info' ||
        Object.entries(request).some(
          ([key, value]) => JSON.stringify(raw[key]) !== JSON.stringify(value)
        )
      )
        throw new Error('Compaction receipt identity changed')
      const policy = compactionPolicy(raw.policy)
      if (JSON.stringify(policy) !== JSON.stringify(options.policy))
        throw new Error('Compaction policy was not confirmed')
      if (raw.error !== undefined) throw new Error('Owned compaction did not complete')
      if (
        options.operation === 'compact' &&
        (!compactionRecord(raw.summary) ||
          typeof raw.summary.summary !== 'string' ||
          !raw.summary.summary ||
          typeof raw.summary.tokensBefore !== 'number' ||
          !Number.isFinite(raw.summary.tokensBefore) ||
          Number(raw.summary.tokensBefore) < 0 ||
          (raw.summary.tokensAfter !== undefined &&
            (typeof raw.summary.tokensAfter !== 'number' ||
              !Number.isFinite(raw.summary.tokensAfter) ||
              raw.summary.tokensAfter < 0)) ||
          (raw.summary.shortSummary !== undefined && typeof raw.summary.shortSummary !== 'string'))
      )
        throw new Error('Compaction summary was not confirmed')
      resolve(raw as unknown as RpcCompactionNotification)
    } catch (error) {
      reject(error)
    }
  })
  const disconnect = connection.onDisconnect(({ error }) => reject(error))
  try {
    const submission = (async () => {
      options.assertCurrent()
      const commands = await withRemoteSignal(
        connection.request<{ commands?: unknown }>({ type: 'get_available_commands' }),
        signal
      )
      options.assertCurrent()
      const matches = Array.isArray(commands.commands)
        ? commands.commands.filter(
            (value) => compactionRecord(value) && value.name === RPC_COMPACTION_COMMAND
          )
        : []
      if (
        matches.length !== 1 ||
        !compactionRecord(matches[0]) ||
        matches[0].source !== 'extension' ||
        matches[0].description !== RPC_COMPACTION_DESCRIPTION
      )
        throw new Error('Owned compaction extension is unavailable')
      dispatched = true
      const receipt = await withRemoteSignal(
        connection.prompt(`/${RPC_COMPACTION_COMMAND} ${JSON.stringify(request)}`),
        signal
      )
      options.assertCurrent()
      if (receipt.agentInvoked || receipt.status !== 'completed')
        throw new Error('Compaction command did not settle locally')
    })()
    const [, notification] = await withRemoteSignal(Promise.all([submission, outcome]), signal)
    return notification
  } finally {
    off()
    disconnect()
  }
}

export function assertRuntimeIdleState(
  raw: unknown,
  snapshot: import('./remote-session-runtime').RemoteRuntimeSnapshot
): void {
  if (
    !compactionRecord(raw) ||
    !compactionRecord(raw.model) ||
    raw.sessionId !== snapshot.reference.ompSessionId ||
    raw.sessionFile !== snapshot.checkpoint.journalPath ||
    raw.model.provider !== snapshot.model.provider ||
    raw.model.id !== snapshot.model.id ||
    raw.thinkingLevel !== snapshot.thinkingLevel ||
    raw.isStreaming !== false ||
    raw.isCompacting !== false ||
    raw.isSettled !== true ||
    raw.hasPendingAsyncWork !== false ||
    raw.queuedMessageCount !== 0
  )
    throw new Error('Compaction/control requires the verified idle SDK session')
}
