import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type { WorkspaceHost } from '../../workspace-host/types'
import type { RemoteUploadFileOptions } from '../../transfer/remote-upload-types'
import { shellQuote as q } from '../../wrappers/remote-ssh-session'
import { privateRemotePrefix } from './extension-deployment/remote-commands'
import type { RpcStartupTransactionWriter } from './startup-transaction'
import {
  encodeHostResult,
  encodeHostResultEnvelope,
  hostResultLookupId,
  hostResultPlaceholder,
  hostProgressPlaceholder,
  signHostResultReceipt,
  validHostResultIdentity,
  type HostResultIdentity,
  type HostResultPayload,
  type HostResultReceipt
} from '../phi-extension/lib/rpc-host-result-protocol'

export type HostResultLease = Pick<
  HostResultIdentity,
  'leaseId' | 'generation' | 'phiSessionId' | 'projectId' | 'cwd'
>
export interface HostResultCall {
  runId: string
  invocationId: string
  toolCallId: string
  toolName: string
  progressSequence?: number
}
export interface RpcHostResultDeliveryOptions {
  host: WorkspaceHost
  startup: RpcStartupTransactionWriter
  /** Canonical, already attested, private generation directory; never from model input. */
  generationDirectory: string
  lease: HostResultLease
  /** Independent 256-bit secret shared privately with the server extension. */
  capability: string
  signal: AbortSignal
  uploadOptions?: Pick<
    RemoteUploadFileOptions,
    'hostKey' | 'workspaceId' | 'coordinator' | 'agentDir' | 'helperConnect'
  >
}
interface Reservation {
  receipt: HostResultReceipt
  fileBytes: number
  controller: AbortController
  detach(): void
}
const MAX_FILES = 16
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
function afterOrCancelled(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** One generation owns this uploader and its opaque private directory. No RPC limit is changed. */
export class RpcHostResultDelivery {
  readonly directory: string
  private readonly reservations = new Map<string, Reservation>()
  private tail: Promise<unknown> = Promise.resolve()
  private bytes = 0
  private retired = false
  private disposal?: Promise<void>
  private readonly cleanups = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()
  private constructor(private readonly options: RpcHostResultDeliveryOptions) {
    this.options = Object.freeze({
      ...options,
      lease: Object.freeze({ ...options.lease }),
      uploadOptions: options.uploadOptions && Object.freeze({ ...options.uploadOptions })
    })
    this.directory = posix.join(
      options.generationDirectory,
      `host-results-${randomBytes(32).toString('hex')}`
    )
  }
  static async create(options: RpcHostResultDeliveryOptions): Promise<RpcHostResultDelivery> {
    if (
      !options.host.transfer ||
      !options.startup ||
      !/^[a-f0-9]{64}$/.test(options.capability) ||
      !validHostResultIdentity({
        ...options.lease,
        runId: 'preflight',
        invocationId: 'preflight',
        toolCallId: 'preflight',
        toolName: 'preflight'
      })
    )
      throw new Error('Host result transfer requires a streaming transport and private capability')
    const delivery = new RpcHostResultDelivery(options)
    options.signal.throwIfAborted()
    options.startup.addDirectory({ path: delivery.directory, ifAbsent: true })
    options.signal.addEventListener('abort', delivery.abort, { once: true })
    options.signal.throwIfAborted()
    return delivery
  }
  private abort = (): void => {
    void this.dispose().catch(() => undefined)
  }
  matchesScope(
    scope: Pick<HostResultLease, 'generation' | 'phiSessionId' | 'projectId' | 'cwd'>
  ): boolean {
    return (
      !this.retired &&
      (['generation', 'phiSessionId', 'projectId', 'cwd'] as const).every(
        (key) => this.options.lease[key] === scope[key]
      )
    )
  }
  async publish(
    result: HostResultPayload,
    call: HostResultCall,
    signal: AbortSignal,
    after: Promise<void> = Promise.resolve()
  ): Promise<HostResultPayload> {
    signal.throwIfAborted()
    if (this.retired) throw new Error('Host result generation retired')
    const payload = encodeHostResult(result)
    const nullDetails = result.details === null
    const receipt = signHostResultReceipt(
      {
        ...this.options.lease,
        ...call,
        type: 'phi_host_result_receipt',
        version: 1,
        receiptId: hostResultLookupId({ ...this.options.lease, ...call }, this.options.capability),
        bytes: payload.length,
        sha256: createHash('sha256').update(payload).digest('hex')
      },
      this.options.capability
    )
    const envelope = encodeHostResultEnvelope(receipt, payload)
    const envelopeHash = createHash('sha256').update(envelope).digest('hex')
    if (
      this.reservations.has(receipt.receiptId) ||
      this.reservations.size >= MAX_FILES ||
      this.bytes + envelope.length > MAX_TOTAL_BYTES
    )
      throw new Error('Host result file/byte budget exhausted')
    const controller = new AbortController()
    const cancel = (): void => controller.abort(new Error('Host result delivery cancelled'))
    signal.addEventListener('abort', cancel, { once: true })
    this.lifetime.signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted || this.lifetime.signal.aborted) cancel()
    const reservation: Reservation = {
      receipt,
      fileBytes: envelope.length,
      controller,
      detach: () => {
        signal.removeEventListener('abort', cancel)
        this.lifetime.signal.removeEventListener('abort', cancel)
      }
    }
    this.reservations.set(receipt.receiptId, reservation)
    this.bytes += envelope.length
    const operation = this.tail
      .catch(() => undefined)
      .then(async () => {
        const staging = this.path(receipt, '.partial')
        const destination = this.path(receipt)
        let local: string | undefined
        try {
          await afterOrCancelled(after, controller.signal)
          controller.signal.throwIfAborted()
          if (this.retired) throw new Error('Host result generation retired')
          local = await mkdtemp(join(tmpdir(), 'phi-host-result-'))
          const source = join(local, 'result.json')
          await writeFile(source, envelope, { flag: 'wx', mode: 0o600 })
          await this.options.host.transfer!.uploadFile(source, staging, {
            ...this.options.uploadOptions,
            signal: controller.signal,
            timeoutMs: 30_000,
            expectedSha256: envelopeHash,
            remoteRoot: this.options.generationDirectory,
            canonicalRoot: this.options.generationDirectory,
            reuseVerifiedDestination: false,
            transferId: `phi-host-result-${receipt.receiptId}`
          })
          controller.signal.throwIfAborted()
          await this.run(
            `private_dir ${q(this.directory)}\nprivate_file ${q(staging)}\n[ "$(wc -c < ${q(staging)} | tr -d ' ')" = ${q(String(envelope.length))} ] || fail 'Host result size mismatch'\n[ "$(hash_file ${q(staging)})" = ${q(envelopeHash)} ] || fail 'Host result hash mismatch'\n[ ! -e ${q(destination)} ] && [ ! -L ${q(destination)} ] || fail 'Host result destination exists'\nmv -- ${q(staging)} ${q(destination)}`,
            controller.signal
          )
          controller.signal.throwIfAborted()
          return call.progressSequence === undefined
            ? hostResultPlaceholder(nullDetails)
            : hostProgressPlaceholder(call.progressSequence)
        } catch (error) {
          await this.remove(receipt)
          this.forget(receipt.receiptId)
          throw error
        } finally {
          if (local) await rm(local, { recursive: true, force: true })
        }
      })
    this.tail = operation
    // The rejection is observed even if a caller retires without awaiting publication.
    void operation.catch(() => undefined)
    return operation
  }
  /** Only call for the trusted server tool_execution_end, never a model-supplied acknowledgement. */
  consumed(runId: string, toolCallId: string, progressSequence?: number): void {
    if (this.retired) return
    for (const reservation of this.reservations.values()) {
      if (
        reservation.receipt.runId === runId &&
        reservation.receipt.toolCallId === toolCallId &&
        (progressSequence === undefined ||
          reservation.receipt.progressSequence === progressSequence)
      ) {
        const cleanup = this.remove(reservation.receipt).then(() =>
          this.forget(reservation.receipt.receiptId)
        )
        this.cleanups.add(cleanup)
        void cleanup.catch(() => undefined).finally(() => this.cleanups.delete(cleanup))
      }
    }
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.retired = true
    this.options.signal.removeEventListener('abort', this.abort)
    this.lifetime.abort(new Error('Host result generation retired'))
    this.disposal = (async () => {
      await this.tail.catch(() => undefined)
      await Promise.allSettled([...this.cleanups])
      for (const reservation of [...this.reservations.values()]) {
        await this.remove(reservation.receipt)
        this.forget(reservation.receipt.receiptId)
      }
      await this.removePath(this.directory, true)
    })()
    return this.disposal
  }
  private async removePath(path: string, recursive = false): Promise<void> {
    // WorkspaceHost.fs.remove may canonicalize the final symlink. Use lexical rm
    // under the private parent so cleanup can never remove a symlink's target.
    const parent = recursive ? this.options.generationDirectory : this.directory
    await this.run(
      `if [ -e ${q(path)} ] || [ -L ${q(path)} ]; then
[ -d ${q(parent)} ] && [ ! -L ${q(parent)} ] || fail 'Invalid host result cleanup parent'
[ "$(cd -P -- ${q(parent)} && pwd -P)" = ${q(parent)} ] || fail 'Noncanonical host result cleanup parent'
owned ${q(parent)}
rm -${recursive ? 'rf' : 'f'} -- ${q(path)}
fi`,
      new AbortController().signal
    )
  }

  private forget(id: string): void {
    const reservation = this.reservations.get(id)
    if (!reservation) return
    reservation.detach()
    this.bytes -= reservation.fileBytes
    this.reservations.delete(id)
  }
  private path(receipt: HostResultReceipt, suffix = ''): string {
    return posix.join(this.directory, `${receipt.receiptId}.json${suffix}`)
  }
  private async remove(receipt: HostResultReceipt): Promise<void> {
    await Promise.all([
      this.removePath(this.path(receipt)),
      this.removePath(this.path(receipt, '.partial'))
    ])
  }
  private async run(command: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const root = this.options.generationDirectory
    const result = await this.options.host.exec.run(
      ['sh', '-c', `${privateRemotePrefix(root)}\nprivate_dir ${q(root)}\n${command}`],
      { cwd: root, signal, timeoutMs: 10_000, maxOutputBytes: 4096 }
    )
    signal.throwIfAborted()
    if (result.code !== 0 || result.truncated || result.terminationReason)
      throw new Error('Private host result publication failed')
  }
}
