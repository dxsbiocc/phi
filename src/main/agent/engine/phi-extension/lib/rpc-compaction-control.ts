export const RPC_COMPACTION_COMMAND = 'phi-rpc-compaction-control'
export const RPC_COMPACTION_DESCRIPTION = 'Phi owned compaction controls v1'
export const RPC_COMPACTION_METHODS = ['remote', 'snapcompact', 'handoff', 'shake', 'soft'] as const
export interface RpcCompactionPolicy {
  readonly enabled: boolean
  readonly thresholdPercent: number
  readonly thresholdTokens: number
  readonly methodOrder: readonly (typeof RPC_COMPACTION_METHODS)[number][]
}
export interface RpcCompactionIdentity {
  readonly nonce: string
  readonly phiSessionId: string
  readonly generation: number
  readonly ompSessionId: string
  readonly journalPath: string
}
export interface RpcCompactionRequest extends RpcCompactionIdentity {
  readonly requestId: string
  readonly operation: 'compact' | 'settings'
  readonly expectedPolicy: RpcCompactionPolicy
}
export interface RpcCompactionSummary {
  readonly summary: string
  readonly shortSummary?: string
  readonly tokensBefore: number
  readonly tokensAfter?: number
}
export interface RpcCompactionNotification extends RpcCompactionRequest {
  readonly type: 'phi_rpc_compaction_control'
  readonly policy: RpcCompactionPolicy
  readonly summary?: RpcCompactionSummary
}
export const compactionRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export function compactionPolicy(raw: unknown): Readonly<RpcCompactionPolicy> {
  if (
    !compactionRecord(raw) ||
    Object.keys(raw).sort().join(',') !== 'enabled,methodOrder,thresholdPercent,thresholdTokens' ||
    typeof raw.enabled !== 'boolean' ||
    typeof raw.thresholdPercent !== 'number' ||
    !Number.isFinite(raw.thresholdPercent) ||
    (raw.thresholdPercent !== -1 && raw.thresholdPercent <= 0) ||
    raw.thresholdPercent > 100 ||
    typeof raw.thresholdTokens !== 'number' ||
    !Number.isSafeInteger(raw.thresholdTokens) ||
    raw.thresholdTokens < -1 ||
    !Array.isArray(raw.methodOrder) ||
    raw.methodOrder.length > RPC_COMPACTION_METHODS.length ||
    new Set(raw.methodOrder).size !== raw.methodOrder.length ||
    raw.methodOrder.some((method) => !RPC_COMPACTION_METHODS.includes(method))
  )
    throw new Error('Invalid owned compaction policy')
  return Object.freeze({
    ...raw,
    methodOrder: Object.freeze([...raw.methodOrder])
  }) as unknown as Readonly<RpcCompactionPolicy>
}
export function compactionRequest(raw: unknown): Readonly<RpcCompactionRequest> {
  if (
    !compactionRecord(raw) ||
    Object.keys(raw).sort().join(',') !==
      'expectedPolicy,generation,journalPath,nonce,ompSessionId,operation,phiSessionId,requestId' ||
    ![raw.nonce, raw.phiSessionId, raw.ompSessionId, raw.requestId].every(
      (value) =>
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 128 &&
        !/[\0\r\n]/.test(value)
    ) ||
    !Number.isSafeInteger(raw.generation) ||
    Number(raw.generation) < 1 ||
    typeof raw.journalPath !== 'string' ||
    !raw.journalPath.startsWith('/') ||
    /[\0\r\n]/.test(raw.journalPath) ||
    raw.journalPath.length > 4096 ||
    !['compact', 'settings'].includes(String(raw.operation))
  )
    throw new Error('Invalid owned compaction request')
  return Object.freeze({
    ...raw,
    expectedPolicy: compactionPolicy(raw.expectedPolicy)
  }) as unknown as Readonly<RpcCompactionRequest>
}
