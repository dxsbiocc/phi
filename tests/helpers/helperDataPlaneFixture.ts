import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTransferManager, FileTransferRegistry } from '../../src/main/agent/transfer'
import { HelperTransferDataPlane } from '../../src/main/agent/transfer/helper-data-plane'
import type { TransferRegistryEntry } from '../../src/main/agent/transfer/registry'
import type { TransferEvent, TransferRequest } from '../../src/main/agent/transfer/types'
import { PassThrough, Writable } from 'node:stream'
import {
  decodeHelperBinaryFrame,
  encodeHelperBinaryFrame,
  HelperBinaryFrameType
} from '../../src/main/agent/transfer/helper-data-plane-protocol'
import type { RemoteStdioProcess } from '../../src/main/agent/wrappers/remote-ssh-session'

export type HelperFixtureRequest = Readonly<{
  id: number
  method: string
  params: Record<string, unknown>
}>

export type CapableHelperHooks = Readonly<{
  onRequest?: (
    request: HelperFixtureRequest,
    respond: (id: unknown, result: unknown) => void,
    fail: (id: unknown, code: string, message: string) => void
  ) => boolean | void
  /** close() may return before the owned physical process's closed event. */
  onClose?: (physicallyClosed: () => void) => void
}>

function jsonFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.byteLength)
  return Buffer.concat([header, payload])
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function capableUploadHelper(
  state: {
    files: Map<string, Buffer>
    binaryChunkSizes: number[]
    maxJsonBytes: number
    ackDelayMs?: number
    /** Hold acks until this many chunks are in flight, so a slow runner still fills the window. */
    ackWhenInFlight?: number
    inFlight?: number
    maxInFlight?: number
    breakBinaryFrameOnce?: boolean
    binaryFrameBroken?: boolean
    ackOffset?: (offset: number) => number
    forceBackpressure?: boolean
    binaryBackpressureWrites?: number
    drainEvents?: number
    breakDownloadAtOffset?: number
    downloadBinaryFrameBroken?: boolean
    downloadRequestOffsets?: number[]
  },
  hooks: CapableHelperHooks = {}
): RemoteStdioProcess {
  const input = new PassThrough()
  const stdin: Writable = state.forceBackpressure
    ? new Writable({
        highWaterMark: 1,
        write(chunk: Buffer, _encoding, callback) {
          const content = Buffer.from(chunk)
          if (
            content.subarray(0, 4).toString('ascii') === 'PHDP' ||
            content.subarray(4, 8).toString('ascii') === 'PHDP'
          ) {
            state.binaryBackpressureWrites = (state.binaryBackpressureWrites ?? 0) + 1
          }
          setTimeout(() => {
            input.write(content)
            callback()
          }, 10)
        }
      })
    : input
  stdin.on('drain', () => {
    state.drainEvents = (state.drainEvents ?? 0) + 1
  })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let buffered = Buffer.alloc(0)
  const heldAcks: Array<() => void> = []
  let heldAckTimer: ReturnType<typeof setTimeout> | undefined
  const releaseHeldAcks = (): void => {
    if (heldAckTimer) clearTimeout(heldAckTimer)
    heldAckTimer = undefined
    for (const release of heldAcks.splice(0)) release()
  }
  let uploadPath = ''
  let downloadPath = ''
  let downloadOffset = 0
  let resolveClosed!: (value: { code: number | null; signal: string | null }) => void
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveClosed = resolve
  })
  let closeRequested = false
  const respond = (id: unknown, result: unknown): void => {
    stdout.write(jsonFrame({ jsonrpc: '2.0', id, result }))
  }
  const respondError = (id: unknown, code: string, message: string): void => {
    stdout.write(
      jsonFrame({ jsonrpc: '2.0', id, error: { code: -32602, message, data: { code } } })
    )
  }
  input.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.byteLength >= 4) {
      const length = buffered.readUInt32BE(0)
      if (buffered.byteLength < length + 4) return
      const payload = buffered.subarray(4, length + 4)
      buffered = buffered.subarray(length + 4)
      if (payload.subarray(0, 4).toString('ascii') === 'PHDP') {
        const frame = decodeHelperBinaryFrame(payload)
        if (frame.type === HelperBinaryFrameType.DownloadRequest) {
          assert.equal(frame.offset, downloadOffset)
          state.downloadRequestOffsets?.push(frame.offset)
          const source = state.files.get(downloadPath) ?? Buffer.alloc(0)
          const data = source.subarray(frame.offset, frame.offset + frame.length)
          downloadOffset += data.byteLength
          state.binaryChunkSizes.push(data.byteLength)
          const response = encodeHelperBinaryFrame({
            type: HelperBinaryFrameType.DownloadData,
            transferId: frame.transferId,
            offset: frame.offset,
            length: data.byteLength,
            sha256: createHash('sha256').update(data).digest(),
            data
          })
          const responseHeader = Buffer.alloc(4)
          responseHeader.writeUInt32BE(response.byteLength)
          if (state.breakDownloadAtOffset === frame.offset && !state.downloadBinaryFrameBroken) {
            state.downloadBinaryFrameBroken = true
            stdout.write(Buffer.concat([responseHeader, response.subarray(0, 12)]))
            input.removeAllListeners('data')
            stdout.end()
            resolveClosed({ code: 255, signal: null })
            return
          }
          stdout.write(Buffer.concat([responseHeader, response]))
          continue
        }
        assert.equal(frame.type, HelperBinaryFrameType.UploadData)
        const current = state.files.get(uploadPath) ?? Buffer.alloc(0)
        if (frame.offset !== current.byteLength) {
          stdout.write(
            Buffer.concat([
              (() => {
                const body = encodeHelperBinaryFrame({
                  type: HelperBinaryFrameType.Error,
                  transferId: frame.transferId,
                  offset: frame.offset,
                  length: Buffer.byteLength('OFFSET_MISMATCH'),
                  sha256: Buffer.alloc(32),
                  data: Buffer.from('OFFSET_MISMATCH')
                })
                const header = Buffer.alloc(4)
                header.writeUInt32BE(body.byteLength)
                return Buffer.concat([header, body])
              })()
            ])
          )
          continue
        }
        assert.equal(frame.sha256.toString('hex'), sha256(frame.data))
        state.binaryChunkSizes.push(frame.data.byteLength)
        state.files.set(uploadPath, Buffer.concat([current, frame.data]))
        if (state.breakBinaryFrameOnce && !state.binaryFrameBroken) {
          state.binaryFrameBroken = true
          const ack = encodeHelperBinaryFrame({
            type: HelperBinaryFrameType.UploadAck,
            transferId: frame.transferId,
            offset: state.ackOffset?.(frame.offset) ?? frame.offset,
            length: frame.length,
            sha256: frame.sha256,
            data: Buffer.alloc(0)
          })
          const header = Buffer.alloc(4)
          header.writeUInt32BE(ack.byteLength)
          stdout.write(Buffer.concat([header, ack.subarray(0, 12)]))
          input.removeAllListeners('data')
          stdout.end()
          resolveClosed({ code: 255, signal: null })
          return
        }
        state.inFlight = (state.inFlight ?? 0) + 1
        state.maxInFlight = Math.max(state.maxInFlight ?? 0, state.inFlight)
        const acknowledge = (): void => {
          const ack = encodeHelperBinaryFrame({
            type: HelperBinaryFrameType.UploadAck,
            transferId: frame.transferId,
            offset: state.ackOffset?.(frame.offset) ?? frame.offset,
            length: frame.length,
            sha256: frame.sha256,
            data: Buffer.alloc(0)
          })
          const header = Buffer.alloc(4)
          header.writeUInt32BE(ack.byteLength)
          state.inFlight = Math.max(0, (state.inFlight ?? 1) - 1)
          stdout.write(Buffer.concat([header, ack]))
        }
        const send = (): void => {
          if (state.ackDelayMs) setTimeout(acknowledge, state.ackDelayMs)
          else acknowledge()
        }
        if (state.ackWhenInFlight) {
          heldAcks.push(send)
          // The last chunk may never have company; release it after a short wait.
          if (state.inFlight >= state.ackWhenInFlight) releaseHeldAcks()
          else heldAckTimer ??= setTimeout(releaseHeldAcks, 200)
        } else {
          send()
        }
        continue
      }
      state.maxJsonBytes = Math.max(state.maxJsonBytes, payload.byteLength)
      const request = JSON.parse(payload.toString('utf8')) as {
        id: number
        method: string
        params: Record<string, unknown>
      }
      if (hooks.onRequest?.(request, respond, respondError)) continue
      switch (request.method) {
        case 'protocol.negotiate':
          respond(request.id, {
            protocolVersion: 1,
            capabilities: {
              transferDataPlane: { version: 1, chunkSize: 8 * 1024 * 1024, maxWindow: 2 }
            }
          })
          break
        case 'transfer.inspect': {
          const path = String(request.params.path)
          const content = state.files.get(path)
          respond(request.id, {
            kind: content ? 'file' : 'missing',
            size: content?.byteLength ?? 0,
            availableBytes: Number.MAX_SAFE_INTEGER
          })
          break
        }
        case 'transfer.create':
          state.files.set(String(request.params.path), Buffer.alloc(0))
          respond(request.id, {})
          break
        case 'transfer.truncate': {
          const path = String(request.params.path)
          const content = state.files.get(path) ?? Buffer.alloc(0)
          state.files.set(path, content.subarray(0, Number(request.params.size)))
          respond(request.id, {})
          break
        }
        case 'transfer.upload.open':
          uploadPath = String(request.params.path)
          respond(request.id, {
            offset: request.params.offset,
            chunkSize: 8 * 1024 * 1024,
            window: 2
          })
          break
        case 'transfer.download.open': {
          downloadPath = String(request.params.path)
          downloadOffset = Number(request.params.offset)
          const source = state.files.get(downloadPath)
          if (!source) {
            respondError(request.id, 'INVALID_ARGUMENT', 'source is missing')
            break
          }
          respond(request.id, {
            offset: downloadOffset,
            chunkSize: 8 * 1024 * 1024,
            window: 2,
            sourceIdentity: {
              kind: 'file',
              device: '1',
              inode: '2',
              size: source.byteLength,
              mtime: '3'
            }
          })
          break
        }
        case 'transfer.identity': {
          const source = state.files.get(String(request.params.path))
          if (!source) {
            respondError(request.id, 'INVALID_ARGUMENT', 'source is missing')
            break
          }
          respond(request.id, {
            kind: 'file',
            device: '1',
            inode: '2',
            size: source.byteLength,
            mtime: '3'
          })
          break
        }
        case 'transfer.sync':
        case 'transfer.close':
          respond(request.id, {})
          break
        case 'transfer.hash': {
          const content = state.files.get(String(request.params.path)) ?? Buffer.alloc(0)
          const offset = Number(request.params.offset ?? 0)
          const length = Number(request.params.length ?? content.byteLength - offset)
          respond(request.id, { hash: sha256(content.subarray(offset, offset + length)) })
          break
        }
        case 'transfer.publish': {
          const partial = state.files.get(String(request.params.partialPath))
          if (!partial) {
            respondError(request.id, 'INVALID_PARTIAL', 'missing partial')
            break
          }
          assert.equal(partial.byteLength, request.params.expectedSize)
          assert.equal(sha256(partial), request.params.expectedSha256)
          state.files.set(String(request.params.destinationPath), partial)
          state.files.delete(String(request.params.partialPath))
          respond(request.id, { size: partial.byteLength, hash: sha256(partial) })
          break
        }
        case 'fs.readRange': {
          const content = state.files.get(String(request.params.path))
          if (!content) {
            respondError(request.id, 'INVALID_ARGUMENT', 'file does not exist')
            break
          }
          respond(request.id, {
            content: content.toString('base64'),
            bytesRead: content.byteLength,
            eof: true
          })
          break
        }
        case 'fs.writeAtomic': {
          state.files.set(
            String(request.params.path),
            Buffer.from(String(request.params.content), 'base64')
          )
          respond(request.id, { hash: sha256(state.files.get(String(request.params.path))!) })
          break
        }
        case 'fs.remove':
        case 'transfer.remove':
          state.files.delete(String(request.params.path))
          respond(request.id, {})
          break
        default:
          respondError(request.id, 'INVALID_ARGUMENT', `unexpected method ${request.method}`)
      }
    }
  })
  return {
    stdin,
    stdout,
    stderr,
    closed,
    async close() {
      if (closeRequested) return
      closeRequested = true
      stdin.end()
      if (stdin !== input) input.end()
      stdout.end()
      stderr.end()
      const finish = (): void => resolveClosed({ code: 0, signal: null })
      if (hooks.onClose) hooks.onClose(finish)
      else finish()
    }
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => {
      resolve = done
    }),
    resolve
  }
}

type RecordedRequest = HelperFixtureRequest & { connection: number }

type UploadFixture = {
  plane: HelperTransferDataPlane
  root: string
  content: Buffer
  state: { files: Map<string, Buffer>; binaryChunkSizes: number[]; maxJsonBytes: number }
  requests: RecordedRequest[]
  processes: RemoteStdioProcess[]
  physicallyClosed: Set<number>
  closeRequested: ReturnType<typeof deferred<number>>
  registryRemoved: ReturnType<typeof deferred<void>>
  pausedPersisted: ReturnType<typeof deferred<void>>
  heldCloseIds: number[]
  registry: FileTransferRegistry
  events: TransferEvent[]
  manager: FileTransferManager
  request: TransferRequest
  release(): void
  close(): Promise<void>
}

export function createHelperUploadFixture(
  options: {
    identity?: string
    planeId?: string
    transformProcess?: (connection: number, process: RemoteStdioProcess) => RemoteStdioProcess
    holdClose?: (connection: number, files: Map<string, Buffer>) => boolean
    onRequest?: (
      connection: number,
      ...args: Parameters<NonNullable<CapableHelperHooks['onRequest']>>
    ) => boolean | void
  } = {}
): UploadFixture {
  const root = mkdtempSync(join(tmpdir(), 'phi-helper-lifecycle-'))
  const content = Buffer.alloc(1024, 0x53)
  const source = join(root, 'source.bin')
  writeFileSync(source, content)
  const state = {
    files: new Map<string, Buffer>(),
    binaryChunkSizes: [] as number[],
    maxJsonBytes: 0
  }
  const requests: RecordedRequest[] = []
  const processes: RemoteStdioProcess[] = []
  const actualProcesses: Array<{
    close: () => Promise<void>
    closed: RemoteStdioProcess['closed']
  }> = []
  const physicallyClosed = new Set<number>()
  const held: Array<() => void> = []
  const heldCloseIds: number[] = []
  const closeRequested = deferred<number>()
  const registryRemoved = deferred()
  const pausedPersisted = deferred()
  const events: TransferEvent[] = []
  let closing = false
  class Registry extends FileTransferRegistry {
    override async upsert(entry: TransferRegistryEntry): Promise<void> {
      await super.upsert(entry)
      if (entry.status === 'paused') pausedPersisted.resolve()
    }
    override async remove(id: string): Promise<void> {
      await super.remove(id)
      registryRemoved.resolve()
    }
  }
  const registry = new Registry(join(root, 'registry.json'))
  const hostId = options.identity ?? 'lifecycle-host'
  const workspaceId = hostId + '-workspace'
  const plane = new HelperTransferDataPlane({
    id: options.planeId,
    hostId,
    workspaceId,
    remoteRoot: '/srv/project',
    canonicalRoot: '/srv/project',
    connect: async () => {
      const connection = processes.length + 1
      const actual = capableUploadHelper(state, {
        onRequest(request, respond, fail) {
          requests.push({ ...request, connection })
          return options.onRequest?.(connection, request, respond, fail)
        },
        onClose(finish) {
          if (!closing && options.holdClose?.(connection, state.files)) {
            held.push(finish)
            heldCloseIds.push(connection)
            closeRequested.resolve(connection)
          } else finish()
        }
      })
      actualProcesses.push({ close: actual.close.bind(actual), closed: actual.closed })
      const process = options.transformProcess?.(connection, actual) ?? actual
      processes.push(process)
      void process.closed.then(
        ({ code, signal }) => {
          if (code === 0 && signal === null) physicallyClosed.add(connection)
        },
        () => undefined
      )
      return process
    },
    fallback: {
      id: 'ssh',
      destinationKey: (request) => JSON.stringify(request.destination),
      async open() {
        throw new Error('capable framed helper must not fall back to SSH')
      }
    }
  })
  const request: TransferRequest = {
    transferId: 'metadata-lifecycle',
    direction: 'upload',
    hostKey: hostId,
    dataPlaneId: plane.id,
    source: { kind: 'local-path', path: source },
    destination: {
      kind: 'remote-workspace-path',
      hostId,
      workspaceId,
      relativePath: 'result.bin'
    },
    expectedSha256: sha256(content)
  }
  const manager = new FileTransferManager({
    registry,
    dataPlanes: [plane],
    onEvent: (event) => {
      events.push(event)
    }
  })
  return {
    plane,
    root,
    content,
    state,
    requests,
    processes,
    physicallyClosed,
    closeRequested,
    registryRemoved,
    pausedPersisted,
    heldCloseIds,
    registry,
    events,
    manager,
    request,
    release() {
      for (const finish of held.splice(0)) finish()
    },
    async close() {
      closing = true
      for (const finish of held.splice(0)) finish()
      await Promise.allSettled(actualProcesses.map((process) => process.close()))
      await Promise.allSettled(actualProcesses.map((process) => process.closed))
      rmSync(root, { recursive: true, force: true })
    }
  }
}
