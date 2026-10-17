import { createHash, randomUUID } from 'node:crypto'

import {
  parseSessionManifestRequest,
  RPC_MANIFEST_COMMAND,
  RPC_SESSION_MANIFEST_DESCRIPTION,
  RPC_SESSION_MANIFEST_TYPE,
  SessionVerificationError,
  verificationRecord,
  type SessionManifestValue,
  type SessionVerificationCode,
  type SessionVerificationIdentity
} from '../phi-extension/lib/rpc-session-verification-protocol'
import type { RpcConnection } from './connection'
import type { RemoteSessionReference } from './session-storage/types'
import type { RpcControlChannel } from './types'

const codes: readonly SessionVerificationCode[] = [
  'FILE_INVALID',
  'ASSET_MISSING',
  'IDENTITY_MISMATCH',
  'SESSION_BUSY',
  'VERIFICATION_LIMIT',
  'GENERATION_REVOKED',
  'PERSISTENCE_FAILED'
]

export async function publishRemoteSessionManifestOverRpc(options: {
  readonly connection: Pick<RpcConnection, 'request' | 'prompt' | 'bindControl'>
  readonly control: RpcControlChannel
  readonly identity: SessionVerificationIdentity
  readonly reference: RemoteSessionReference
  readonly signal: AbortSignal
  readonly assertActive: () => void
  readonly timeoutMs?: number
}): Promise<void> {
  const { connection, control, signal } = options
  const manifest = Object.freeze({
    ...options.reference,
    schemaVersion: 1
  }) as SessionManifestValue
  const request = parseSessionManifestRequest(
    JSON.stringify({
      schemaVersion: 1,
      requestId: randomUUID(),
      nonce: options.identity.nonce,
      phiSessionId: options.identity.phiSessionId,
      generation: options.identity.generation,
      manifest
    }),
    options.identity
  )
  const expectedSha256 = createHash('sha256')
    .update(`${JSON.stringify(request.manifest)}\n`)
    .digest('hex')
  let rejectFailure!: (error: Error) => void
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject
  })
  void failure.catch(() => undefined)
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  let started = false
  const active = (): void => {
    options.assertActive()
    if (
      signal.aborted ||
      control.signal.aborted ||
      connection.bindControl().generation !== control.generation
    )
      throw new SessionVerificationError('GENERATION_REVOKED')
  }
  const stop = (code: SessionVerificationCode): void =>
    rejectFailure(new SessionVerificationError(code))
  const abort = (): void => stop('GENERATION_REVOKED')
  signal.addEventListener('abort', abort, { once: true })
  control.signal.addEventListener('abort', abort, { once: true })
  const off = control.onFrame((frame) => {
    if (frame.type === 'agent_start') return stop('SESSION_BUSY')
    if (
      started &&
      frame.type === 'extension_error' &&
      frame.extensionPath === `command:${RPC_MANIFEST_COMMAND}`
    )
      return stop('PERSISTENCE_FAILED')
    if (
      !started ||
      frame.type !== 'extension_ui_request' ||
      frame.method !== 'notify' ||
      frame.notifyType !== 'info' ||
      typeof frame.message !== 'string'
    )
      return
    try {
      const raw: unknown = JSON.parse(frame.message)
      if (
        Buffer.byteLength(frame.message) > 20 * 1024 ||
        !verificationRecord(raw) ||
        raw.type !== RPC_SESSION_MANIFEST_TYPE ||
        !verificationRecord(raw.request) ||
        raw.request.requestId !== request.requestId ||
        Object.keys(raw).sort().join(',') !==
          (raw.error === undefined ? 'request,sha256,type' : 'error,request,type')
      )
        return stop('IDENTITY_MISMATCH')
      const echo = parseSessionManifestRequest(JSON.stringify(raw.request), options.identity)
      if (JSON.stringify(echo) !== JSON.stringify(request)) return stop('IDENTITY_MISMATCH')
      if (raw.error !== undefined) {
        if (!codes.includes(raw.error as SessionVerificationCode)) return stop('IDENTITY_MISMATCH')
        return stop(raw.error as SessionVerificationCode)
      }
      if (raw.sha256 !== expectedSha256) return stop('IDENTITY_MISMATCH')
      resolveReady()
    } catch {
      stop('IDENTITY_MISMATCH')
    }
  })
  const timer = setTimeout(() => stop('VERIFICATION_LIMIT'), options.timeoutMs ?? 30_000)
  try {
    await Promise.race([
      (async () => {
        active()
        const available = await connection.request<unknown>({ type: 'get_available_commands' })
        active()
        const commands =
          verificationRecord(available) && Array.isArray(available.commands)
            ? available.commands.filter(
                (value) => verificationRecord(value) && value.name === RPC_MANIFEST_COMMAND
              )
            : []
        if (
          commands.length !== 1 ||
          !verificationRecord(commands[0]) ||
          commands[0].source !== 'extension' ||
          commands[0].description !== RPC_SESSION_MANIFEST_DESCRIPTION
        )
          throw new SessionVerificationError('IDENTITY_MISMATCH')
        started = true
        const [, result] = await Promise.all([
          ready,
          connection.prompt(`/${RPC_MANIFEST_COMMAND} ${JSON.stringify(request)}`)
        ])
        active()
        if (result.agentInvoked || result.status !== 'completed' || !result.sessionSettled)
          throw new SessionVerificationError('SESSION_BUSY')
      })(),
      failure
    ])
  } finally {
    clearTimeout(timer)
    off()
    signal.removeEventListener('abort', abort)
    control.signal.removeEventListener('abort', abort)
  }
}
