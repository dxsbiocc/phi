import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { RpcConnection } from './connection'
import type { RpcControlChannel } from './types'
import type { RemoteSessionReference } from './session-storage/types'
import type { RemoteRecoveryAttachment } from './session-recovery'
import {
  parseSessionVerificationRequest,
  SessionVerificationError,
  validateVerificationIdentity,
  verificationFailure,
  verificationRecord,
  verificationText,
  RPC_CHECKPOINT_COMMAND,
  RPC_SAVED_STATE_COMMAND,
  RPC_SESSION_VERIFICATION_DESCRIPTION,
  RPC_SESSION_VERIFICATION_TYPE,
  type SessionVerificationCode,
  type SessionVerificationIdentity,
  type SessionVerificationProof,
  type SessionVerificationRequest
} from '../phi-extension/lib/rpc-session-verification-protocol'

const codes: readonly SessionVerificationCode[] = [
  'FILE_INVALID',
  'ASSET_MISSING',
  'IDENTITY_MISMATCH',
  'SESSION_BUSY',
  'VERIFICATION_LIMIT',
  'GENERATION_REVOKED',
  'PERSISTENCE_FAILED'
]

function parseProof(
  value: unknown,
  request: SessionVerificationRequest,
  identity: SessionVerificationIdentity
): SessionVerificationProof {
  const keys = [
    'ompSessionId',
    'phiSessionId',
    'generation',
    'projectRoot',
    'journalPath',
    'leafId',
    'model',
    'journalDigest',
    'assetDigest',
    'entryCount',
    'blobCount',
    'artifactCount'
  ]
  if (
    !verificationRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    value.ompSessionId !== request.ompSessionId ||
    value.phiSessionId !== identity.phiSessionId ||
    value.generation !== identity.generation ||
    value.projectRoot !== identity.projectRoot ||
    value.journalPath !== posix.join(identity.journals, request.journalBasename) ||
    !(value.leafId === null || verificationText(value.leafId)) ||
    typeof value.journalDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.journalDigest) ||
    typeof value.assetDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.assetDigest) ||
    ['entryCount', 'blobCount', 'artifactCount'].some(
      (key) => !Number.isSafeInteger(value[key]) || (value[key] as number) < 0
    ) ||
    !(
      value.model === null ||
      (verificationRecord(value.model) &&
        Object.keys(value.model).sort().join(',') === 'id,provider' &&
        verificationText(value.model.provider, 1024) &&
        verificationText(value.model.id, 1024))
    )
  )
    verificationFailure('IDENTITY_MISMATCH')
  return Object.freeze({
    ...value,
    model:
      value.model === null ? null : Object.freeze({ ...(value.model as Record<string, unknown>) })
  }) as unknown as SessionVerificationProof
}

export function createRpcSessionVerifier(options: {
  readonly connection: Pick<RpcConnection, 'request' | 'prompt' | 'bindControl'>
  readonly control: RpcControlChannel
  readonly identity: SessionVerificationIdentity
  /** Owns the exclusive initialization/after-turn gate; no ordinary prompt may be admitted. */
  readonly assertActive: () => void
  readonly timeoutMs?: number
}): {
  verifySavedState(
    reference: RemoteSessionReference,
    signal: AbortSignal
  ): Promise<SessionVerificationProof>
  verifyAttachment(
    identity: Omit<RemoteRecoveryAttachment, 'leafId'>,
    signal: AbortSignal
  ): Promise<SessionVerificationProof>
  /** Root calls only after the verified attachment is durably adopted under the same gate. */
  commitAttachment(): void
} {
  const identity = Object.freeze({ ...options.identity })
  validateVerificationIdentity(identity)
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) verificationFailure('VERIFICATION_LIMIT')
  const { connection, control } = options
  if (control.generation !== identity.generation) verificationFailure('IDENTITY_MISMATCH')
  let inFlight = false
  let savedBaseline: SessionVerificationProof | undefined
  let attachment: SessionVerificationProof | undefined
  let faulted = false
  const invoke = async (
    action: 'saved' | 'checkpoint',
    ompSessionId: string,
    journalBasename: string,
    signal: AbortSignal
  ): Promise<SessionVerificationProof> => {
    if (faulted) verificationFailure('GENERATION_REVOKED')
    if (inFlight) verificationFailure('SESSION_BUSY')
    const request = parseSessionVerificationRequest(
      JSON.stringify({
        schemaVersion: 1,
        requestId: randomUUID(),
        nonce: identity.nonce,
        phiSessionId: identity.phiSessionId,
        generation: identity.generation,
        action,
        ompSessionId,
        journalBasename
      }),
      identity,
      action
    )
    inFlight = true
    let rejectFailure!: (error: Error) => void
    const failure = new Promise<never>((_, reject) => {
      rejectFailure = reject
    })
    void failure.catch(() => undefined)
    let resolveProof!: (value: SessionVerificationProof) => void
    const received = new Promise<SessionVerificationProof>((resolve) => {
      resolveProof = resolve
    })
    let stopped: Error | undefined
    const stop = (code: SessionVerificationCode): void => {
      stopped ??= new SessionVerificationError(code)
      rejectFailure(stopped)
    }
    const active = (): void => {
      try {
        options.assertActive()
      } catch {
        verificationFailure('GENERATION_REVOKED')
      }
      if (
        signal.aborted ||
        control.signal.aborted ||
        connection.bindControl().generation !== control.generation
      )
        verificationFailure('GENERATION_REVOKED')
      if (stopped) throw stopped
    }
    const abort = (): void => stop('GENERATION_REVOKED')
    signal.addEventListener('abort', abort, { once: true })
    control.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop('VERIFICATION_LIMIT'), timeoutMs)
    let started = false
    const off = control.onFrame((frame) => {
      if (frame.type === 'agent_start') {
        stop('SESSION_BUSY')
        return
      }
      if (
        started &&
        frame.type === 'extension_error' &&
        frame.extensionPath ===
          `command:${action === 'saved' ? RPC_SAVED_STATE_COMMAND : RPC_CHECKPOINT_COMMAND}`
      ) {
        stop('FILE_INVALID')
        return
      }
      if (
        !started ||
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
        !verificationRecord(raw) ||
        raw.type !== RPC_SESSION_VERIFICATION_TYPE ||
        !verificationRecord(raw.request) ||
        raw.request.requestId !== request.requestId
      )
        return
      try {
        if (
          Buffer.byteLength(frame.message) > 16 * 1024 ||
          frame.notifyType !== 'info' ||
          Object.keys(raw).sort().join(',') !==
            (raw.error === undefined ? 'proof,request,type' : 'error,request,type')
        )
          verificationFailure('IDENTITY_MISMATCH')
        const echo = parseSessionVerificationRequest(JSON.stringify(raw.request), identity, action)
        if (
          Object.keys(request).some(
            (key) =>
              echo[key as keyof SessionVerificationRequest] !==
              request[key as keyof SessionVerificationRequest]
          )
        )
          verificationFailure('IDENTITY_MISMATCH')
        if (raw.error !== undefined) {
          if (!codes.includes(raw.error as SessionVerificationCode))
            verificationFailure('IDENTITY_MISMATCH')
          stop(raw.error as SessionVerificationCode)
        } else resolveProof(parseProof(raw.proof, request, identity))
      } catch (error) {
        stop(error instanceof SessionVerificationError ? error.code : 'IDENTITY_MISMATCH')
      }
    })
    const settled = async (): Promise<Record<string, unknown>> => {
      active()
      const state = await connection.request<unknown>({ type: 'get_state' })
      active()
      if (
        !verificationRecord(state) ||
        state.isStreaming !== false ||
        state.isCompacting !== false ||
        state.isSettled !== true ||
        state.queuedMessageCount !== 0 ||
        state.hasPendingAsyncWork !== false
      )
        verificationFailure('SESSION_BUSY')
      return state
    }
    try {
      return await Promise.race([
        (async () => {
          active()
          const before = await settled()
          const command = action === 'saved' ? RPC_SAVED_STATE_COMMAND : RPC_CHECKPOINT_COMMAND
          const available = await connection.request<unknown>({ type: 'get_available_commands' })
          active()
          const commands =
            verificationRecord(available) && Array.isArray(available.commands)
              ? available.commands.filter(
                  (value) => verificationRecord(value) && value.name === command
                )
              : []
          if (
            commands.length !== 1 ||
            !verificationRecord(commands[0]) ||
            commands[0].source !== 'extension' ||
            commands[0].description !== RPC_SESSION_VERIFICATION_DESCRIPTION
          )
            verificationFailure('IDENTITY_MISMATCH')
          started = true
          const [proof, result] = await Promise.all([
            received,
            connection.prompt(`/${command} ${JSON.stringify(request)}`)
          ])
          active()
          if (result.agentInvoked || result.status !== 'completed' || !result.sessionSettled)
            verificationFailure('SESSION_BUSY')
          const after = await settled()
          if (
            after.sessionId !== before.sessionId ||
            after.sessionFile !== before.sessionFile ||
            (action === 'checkpoint' &&
              (after.sessionId !== ompSessionId || after.sessionFile !== proof.journalPath))
          )
            verificationFailure('IDENTITY_MISMATCH')
          return proof
        })(),
        failure
      ])
    } catch (error) {
      // Once a command may be running, a failure retires this verifier. Root
      // must revoke the owned generation instead of retrying into an old proof.
      if (started) faulted = true
      if (error instanceof SessionVerificationError) throw error
      throw new SessionVerificationError('FILE_INVALID')
    } finally {
      clearTimeout(timer)
      off()
      signal.removeEventListener('abort', abort)
      control.signal.removeEventListener('abort', abort)
      inFlight = false
    }
  }
  return {
    async verifySavedState(reference, signal) {
      try {
        if (
          reference.phiSessionId !== identity.phiSessionId ||
          reference.projectRoot !== identity.projectRoot
        )
          verificationFailure('IDENTITY_MISMATCH')
        const proof = await invoke(
          'saved',
          reference.ompSessionId,
          reference.journalBasename,
          signal
        )
        if (
          savedBaseline &&
          (savedBaseline.journalPath !== proof.journalPath ||
            savedBaseline.ompSessionId !== proof.ompSessionId ||
            savedBaseline.assetDigest !== proof.assetDigest ||
            savedBaseline.journalDigest !== proof.journalDigest)
        )
          verificationFailure('FILE_INVALID')
        savedBaseline = proof
        return proof
      } catch (error) {
        if (savedBaseline) faulted = true
        throw error
      }
    },
    async verifyAttachment(target, signal) {
      attachment = undefined
      try {
        if (
          target.phiSessionId !== identity.phiSessionId ||
          target.generation !== identity.generation ||
          target.projectRoot !== identity.projectRoot ||
          posix.dirname(target.journalPath) !== identity.journals
        )
          verificationFailure('IDENTITY_MISMATCH')
        const proof = await invoke(
          'checkpoint',
          target.ompSessionId,
          posix.basename(target.journalPath),
          signal
        )
        if (
          savedBaseline &&
          (savedBaseline.ompSessionId !== proof.ompSessionId ||
            savedBaseline.journalPath !== proof.journalPath ||
            savedBaseline.assetDigest !== proof.assetDigest)
        )
          verificationFailure('FILE_INVALID')
        attachment = proof
        return proof
      } catch (error) {
        attachment = undefined
        faulted = true
        throw error
      }
    },
    commitAttachment() {
      if (
        faulted ||
        inFlight ||
        !attachment ||
        control.signal.aborted ||
        connection.bindControl().generation !== control.generation
      )
        verificationFailure('GENERATION_REVOKED')
      try {
        options.assertActive()
      } catch {
        verificationFailure('GENERATION_REVOKED')
      }
      savedBaseline = undefined
      attachment = undefined
    }
  }
}
