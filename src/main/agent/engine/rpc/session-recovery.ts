import { posix } from 'node:path'
import type { RpcConnection } from './connection'
import { remoteJournalPath } from './session-storage/paths'
import { readRemoteHistory, withRemoteSignal, type RemoteHistoryCheckpoint } from './history-pager'
import {
  REMOTE_SESSION_OMP_VERSION,
  RemoteSessionStorageError,
  type RemoteJournalPreflight,
  type RemoteSessionReference,
  type RemoteSessionStoragePreparation
} from './session-storage/types'
import type { RpcControlChannel } from './types'
import { RuntimeReferenceError } from '../../session/runtime-reference'
import { SessionVerificationError } from '../phi-extension/lib/rpc-session-verification-protocol'
import type { RuntimeRecoveryIssue } from '../../../../shared/runtimeRecoveryTypes'

export interface RemoteRecoveryModel {
  readonly provider: string
  readonly id: string
}
export type RemoteRecoveryAction =
  | { readonly type: 'new'; readonly model: RemoteRecoveryModel }
  | {
      readonly type: 'resume'
      readonly reference: RemoteSessionReference
      readonly savedModel: RemoteRecoveryModel
      readonly replacement?: RemoteRecoveryModel
    }

export type RemoteRecoveryErrorCode =
  | 'RESTORE_CANCELLED'
  | 'GENERATION_REVOKED'
  | 'IDENTITY_MISMATCH'
  | 'MODEL_UNAVAILABLE'
  | 'UNEXPECTED_EXECUTION'
  | 'SESSION_BUSY'
  | 'PERSISTENCE_FAILED'
  | 'FILE_INVALID'
  | 'ASSET_MISSING'
export class RemoteRecoveryError extends Error {
  constructor(
    readonly code: RemoteRecoveryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'RemoteRecoveryError'
  }
}

/** Safe user projection only. Raw transport/provider/SDK errors and their causes remain private. */
export function describeRemoteRecoveryFailure(error: unknown): {
  readonly issue: RuntimeRecoveryIssue
  readonly message: string
} {
  const code =
    error instanceof RemoteRecoveryError ||
    error instanceof RemoteSessionStorageError ||
    error instanceof RuntimeReferenceError ||
    error instanceof SessionVerificationError
      ? error.code
      : undefined
  if (code === 'MODEL_UNAVAILABLE')
    return {
      issue: 'model-unavailable',
      message: '原会话模型不可用，请明确选择可用模型后恢复，或根据本地历史另开会话。'
    }
  if (code === 'FILE_MISSING')
    return {
      issue: 'journal-missing',
      message: '服务器会话文件已丢失；本地历史仍可查看，可明确选择根据本地历史另开会话。'
    }
  if (code === 'ASSET_MISSING')
    return {
      issue: 'asset-missing',
      message: '原会话引用的图片或大输出资产缺失，无法完整恢复；本地历史仍可查看。'
    }
  if (
    code === 'FILE_INVALID' ||
    code === 'INVALID_RUNTIME_REFERENCE' ||
    code === 'VERIFICATION_LIMIT'
  )
    return {
      issue: 'journal-invalid',
      message: '服务器会话或资产无法通过完整性验证，已停止恢复；本地历史仍可查看。'
    }
  if (
    code === 'IDENTITY_MISMATCH' ||
    code === 'HOST_IDENTITY_CHANGED' ||
    code === 'PROJECT_MISMATCH' ||
    code === 'INVALID_SCOPE' ||
    code === 'PATH_INVALID'
  )
    return {
      issue: 'binding-changed',
      message: '会话所属项目、主机或目录已改变，请先核对绑定；旧历史没有被迁移或重发。'
    }
  return {
    issue: 'disconnected',
    message:
      '原会话尚未连接或恢复未完成；请重新连接后显式恢复。本地历史仍可查看，旧任务不会自动重发。'
  }
}

export interface RemoteRecoveryAttachment {
  readonly phiSessionId: string
  readonly ompSessionId: string
  readonly journalPath: string
  readonly projectRoot: string
  readonly generation: number
  readonly leafId: string | null
}

export interface RemoteSessionRecoveryOptions {
  readonly action: RemoteRecoveryAction
  readonly storage: RemoteSessionStoragePreparation
  readonly connection: Pick<RpcConnection, 'request' | 'bindControl' | 'abort'>
  readonly control: RpcControlChannel
  readonly signal: AbortSignal
  readonly availableModels: readonly RemoteRecoveryModel[]
  readonly preflight: (
    reference: RemoteSessionReference,
    signal: AbortSignal
  ) => Promise<RemoteJournalPreflight>
  /** Strict current-branch model and referenced blob/artifact proof; header validation alone is insufficient. */
  readonly verifySavedState: (
    reference: RemoteSessionReference,
    signal: AbortSignal
  ) => Promise<{ readonly model: RemoteRecoveryModel | null }>
  /** Apply exact desktop model metadata to the attached target, preserving restored thinking. */
  readonly selectModel: (
    reference: RemoteSessionReference,
    selection: {
      readonly model: RemoteRecoveryModel
      readonly thinkingLevel: string | undefined
      readonly policy: 'fresh' | 'restored' | 'explicit-replacement'
    },
    signal: AbortSignal
  ) => Promise<void>
  /** Reattests cwd/generation and rebinds fresh host/UI capabilities; never restores old waiters. */
  readonly verifyAttachment: (
    identity: Omit<RemoteRecoveryAttachment, 'leafId'>,
    signal: AbortSignal
  ) => Promise<RemoteRecoveryAttachment>
  readonly publish: (
    reference: RemoteSessionReference,
    checkpoint: RemoteHistoryCheckpoint,
    signal: AbortSignal
  ) => Promise<void>
  /** Revokes only this owned RPC generation and its capabilities, never a shared SSH master. */
  readonly interrupt: (error: Error) => Promise<void>
}

export interface RemoteSessionRecoveryResult {
  readonly reference: Readonly<RemoteSessionReference>
  readonly checkpoint: Readonly<RemoteHistoryCheckpoint>
  readonly model: Readonly<RemoteRecoveryModel>
  readonly thinkingLevel: string | undefined
  readonly selectionHandled: true
  readonly modelPolicy: 'fresh' | 'restored' | 'explicit-replacement'
  readonly messages: readonly unknown[]
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function modelSnapshot(model: RemoteRecoveryModel): Readonly<RemoteRecoveryModel> {
  return Object.freeze({ provider: model.provider, id: model.id })
}
function sameModel(a: RemoteRecoveryModel, b: RemoteRecoveryModel): boolean {
  return a.provider === b.provider && a.id === b.id
}
function failure(code: RemoteRecoveryErrorCode, message: string): never {
  throw new RemoteRecoveryError(code, message)
}

/** Explicit attach only. Returning a result grants no execution until root adopts it and marks ready. */
export async function recoverRemoteSession(
  options: RemoteSessionRecoveryOptions
): Promise<RemoteSessionRecoveryResult> {
  const { storage, connection, control } = options
  const supplied = options.action
  const action: RemoteRecoveryAction =
    supplied.type === 'new'
      ? { type: 'new', model: modelSnapshot(supplied.model) }
      : {
          type: 'resume',
          reference: Object.freeze({ ...supplied.reference }),
          savedModel: modelSnapshot(supplied.savedModel),
          ...(supplied.replacement ? { replacement: modelSnapshot(supplied.replacement) } : {})
        }
  const controller = new AbortController()
  let unexpected = false
  const revoked = (): void =>
    controller.abort(new RemoteRecoveryError('GENERATION_REVOKED', 'Recovery generation revoked'))
  const signals = [options.signal, control.signal, storage.lease.signal]
  for (const signal of signals) {
    signal.addEventListener('abort', revoked, { once: true })
    if (signal.aborted) revoked()
  }
  let off = (): void => undefined
  const observe = (frame: { type: string }): void => {
    if (frame.type !== 'agent_start') return
    unexpected = true
    const error = new RemoteRecoveryError(
      'UNEXPECTED_EXECUTION',
      'Recovery unexpectedly started an agent turn'
    )
    controller.abort(error)
    void connection.abort().catch(() => undefined)
    void options.interrupt(error).catch(() => undefined)
  }
  const assertActive = (): void => {
    if (unexpected) failure('UNEXPECTED_EXECUTION', 'Recovery unexpectedly started an agent turn')
    if (controller.signal.aborted || connection.bindControl().generation !== control.generation)
      failure('GENERATION_REVOKED', 'Recovery generation revoked')
    storage.lease.assertActive()
  }
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertActive()
    const result = await withRemoteSignal(operation(), controller.signal)
    assertActive()
    return result
  }
  try {
    assertActive()
    off = control.onFrame(observe)
    const desired =
      action.type === 'resume' ? (action.replacement ?? action.savedModel) : action.model
    if (
      !desired.provider ||
      !desired.id ||
      !options.availableModels.some((model) => sameModel(model, desired))
    )
      failure('MODEL_UNAVAILABLE', 'The exact saved or explicitly selected model is unavailable')
    const scope = storage.scope
    let reference: RemoteSessionReference | undefined =
      action.type === 'resume' ? action.reference : undefined
    if (reference) {
      for (const field of [
        'hostProfileId',
        'bindingHash',
        'projectId',
        'projectRoot',
        'runtimeRoot',
        'phiSessionId'
      ] as const)
        if (reference[field] !== scope[field])
          failure('IDENTITY_MISMATCH', 'Remote reference scope changed')
      if (
        reference.kind !== 'remote-omp' ||
        reference.version !== 1 ||
        reference.ompVersion !== REMOTE_SESSION_OMP_VERSION ||
        reference.durableSessionKey !== storage.paths.durableSessionKey ||
        posix.basename(reference.journalBasename) !== reference.journalBasename ||
        !reference.journalBasename.endsWith('.jsonl')
      )
        failure('IDENTITY_MISMATCH', 'Remote reference is invalid')
    }
    if (reference) {
      remoteJournalPath(scope, reference)
      reference = Object.freeze({
        ...scope,
        kind: 'remote-omp',
        version: 1,
        durableSessionKey: reference.durableSessionKey,
        ompVersion: REMOTE_SESSION_OMP_VERSION,
        ompSessionId: reference.ompSessionId,
        journalBasename: reference.journalBasename
      })
    }
    const before = reference
      ? await run(() => options.preflight(reference!, controller.signal))
      : undefined
    if (
      before &&
      (before.journalPath !== remoteJournalPath(scope, reference!) ||
        before.ompSessionId !== reference!.ompSessionId ||
        before.cwd !== scope.projectRoot)
    )
      failure('IDENTITY_MISMATCH', 'Journal preflight differs from the requested reference')
    if (action.type === 'resume') {
      const saved = await run(() => options.verifySavedState(reference!, controller.signal))
      if (
        (saved.model && !sameModel(saved.model, action.savedModel)) ||
        (!saved.model && !action.replacement)
      )
        failure('MODEL_UNAVAILABLE', 'Journal selection differs from the exact saved model')
    }
    const change = await run(() =>
      connection.request<unknown>(
        action.type === 'new'
          ? { type: 'new_session' }
          : {
              type: 'switch_session',
              sessionPath: posix.join(storage.paths.journals, action.reference.journalBasename),
              ...(action.replacement
                ? { provider: action.replacement.provider, modelId: action.replacement.id }
                : {})
            }
      )
    )
    if (!record(change) || typeof change.cancelled !== 'boolean')
      failure('PERSISTENCE_FAILED', 'Invalid session change response')
    if (change.cancelled) failure('RESTORE_CANCELLED', 'Session change was cancelled')
    const readState = async (checkModel = true): Promise<Record<string, unknown>> => {
      const state = await run(() => connection.request<unknown>({ type: 'get_state' }))
      if (
        !record(state) ||
        typeof state.sessionId !== 'string' ||
        !state.sessionId ||
        typeof state.sessionFile !== 'string' ||
        !Number.isSafeInteger(state.messageCount) ||
        (state.messageCount as number) < 0 ||
        (state.thinkingLevel !== undefined &&
          !['inherit', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
            String(state.thinkingLevel)
          )) ||
        !record(state.model) ||
        typeof state.model.provider !== 'string' ||
        typeof state.model.id !== 'string'
      )
        failure('PERSISTENCE_FAILED', 'Invalid restored session state')
      if (
        state.isStreaming !== false ||
        state.isCompacting !== false ||
        state.isSettled !== true ||
        state.queuedMessageCount !== 0 ||
        state.hasPendingAsyncWork !== false
      )
        failure('SESSION_BUSY', 'Restored session is not settled')
      if (checkModel && !sameModel(desired, { provider: state.model.provider, id: state.model.id }))
        failure('MODEL_UNAVAILABLE', 'Restored model differs from the exact saved selection')
      return state
    }
    const switchedState = await readState(false)
    let state = switchedState
    if (!reference) {
      if (posix.dirname(state.sessionFile as string) !== storage.paths.journals)
        failure('IDENTITY_MISMATCH', 'New session is outside the managed journal directory')
      reference = Object.freeze({
        ...scope,
        kind: 'remote-omp',
        version: 1,
        durableSessionKey: storage.paths.durableSessionKey,
        ompVersion: REMOTE_SESSION_OMP_VERSION,
        ompSessionId: state.sessionId as string,
        journalBasename: posix.basename(state.sessionFile as string)
      })
    }
    if (
      state.sessionId !== reference.ompSessionId ||
      state.sessionFile !== remoteJournalPath(scope, reference)
    )
      failure('IDENTITY_MISMATCH', 'Switched session differs from the durable reference')
    const modelPolicy =
      action.type === 'new' ? 'fresh' : action.replacement ? 'explicit-replacement' : 'restored'
    await run(() =>
      options.selectModel(
        reference!,
        {
          model: desired,
          thinkingLevel:
            typeof switchedState.thinkingLevel === 'string'
              ? switchedState.thinkingLevel
              : undefined,
          policy: modelPolicy
        },
        controller.signal
      )
    )
    state = await readState()
    if (modelPolicy === 'restored' && state.thinkingLevel !== switchedState.thinkingLevel)
      failure('MODEL_UNAVAILABLE', 'Restored thinking selection changed during metadata binding')
    const journalPath = posix.join(storage.paths.journals, reference.journalBasename)
    const identity = Object.freeze({
      phiSessionId: scope.phiSessionId,
      ompSessionId: reference.ompSessionId,
      journalPath,
      projectRoot: scope.projectRoot,
      generation: control.generation
    })
    const checkpoint = async (): Promise<RemoteHistoryCheckpoint> => {
      const current = await readState()
      if (current.sessionId !== reference!.ompSessionId || current.sessionFile !== journalPath)
        failure('IDENTITY_MISMATCH', 'Attached session differs from the durable reference')
      const attachment = await run(() => options.verifyAttachment(identity, controller.signal))
      if (
        Object.keys(identity).some(
          (key) =>
            attachment[key as keyof typeof identity] !== identity[key as keyof typeof identity]
        ) ||
        !(
          attachment.leafId === null ||
          (typeof attachment.leafId === 'string' && attachment.leafId.length > 0)
        )
      )
        failure('IDENTITY_MISMATCH', 'Attached manager scope differs from the verified reference')
      return Object.freeze({
        ...identity,
        leafId: attachment.leafId,
        messageCount: current.messageCount as number
      })
    }
    const verified = await checkpoint()
    const after = await run(() => options.preflight(reference!, controller.signal))
    if (
      after.journalPath !== journalPath ||
      after.ompSessionId !== reference.ompSessionId ||
      after.cwd !== scope.projectRoot ||
      (before && before.fileIdentity !== after.fileIdentity)
    )
      failure('IDENTITY_MISMATCH', 'Journal was deleted, replaced or rebound during recovery')
    // SDK may append an interrupted-turn marker or explicit model_change during switch.
    // A changed revision is allowed only after the same inode/header and final state are re-proved.
    const messages = await run(() =>
      readRemoteHistory({
        connection,
        control,
        checkpoint: verified,
        readCheckpoint: checkpoint,
        signal: controller.signal
      })
    )
    const finalFile = await run(() => options.preflight(reference!, controller.signal))
    if (
      finalFile.fileIdentity !== after.fileIdentity ||
      finalFile.fingerprint !== after.fingerprint
    )
      failure('IDENTITY_MISMATCH', 'Journal changed while history was read')
    await run(() => options.publish(reference!, verified, controller.signal))
    return Object.freeze({
      reference: Object.freeze({ ...reference }),
      checkpoint: verified,
      model: modelSnapshot(desired),
      thinkingLevel: typeof state.thinkingLevel === 'string' ? state.thinkingLevel : undefined,
      selectionHandled: true,
      modelPolicy,
      messages
    })
  } catch (error) {
    const known = error instanceof Error ? error : new Error('Remote recovery failed')
    await options.interrupt(known).catch(() => undefined)
    if (error instanceof RemoteRecoveryError) throw error
    if (/Could not restore model|Unknown model|Model not found/i.test(known.message))
      throw new RemoteRecoveryError(
        'MODEL_UNAVAILABLE',
        'The exact saved model could not be restored',
        { cause: error }
      )
    throw error
  } finally {
    off()
    for (const signal of signals) signal.removeEventListener('abort', revoked)
  }
}
