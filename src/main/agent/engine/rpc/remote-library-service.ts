import { randomUUID } from 'node:crypto'
import {
  auditLibraryIndex,
  findPapersInIndex,
  listPapersInIndex,
  removePaperInIndex,
  savePaperInIndex,
  updatePaperInIndex
} from '../../library/library-store'
import type {
  LibraryListFilters,
  SavePaperInput,
  UpdatePaperInput
} from '../../library/library-types'
import type { LibraryToolStore, LibraryToolStoreFactory } from '../../library/library-tools'
import type { PhiHostRequestContext } from '../types'
import { rpcIdentifier, rpcRecord } from './control-frame'
import { RemoteLibraryStorage } from './remote-library-storage'
import {
  REMOTE_LIBRARY_MAX_REQUEST_BYTES,
  RemoteLibraryError,
  type RemoteLibraryIdentity,
  type RemoteLibraryRequest,
  type RemoteLibraryTarget
} from './remote-library-types'

const actions = new Set(['save', 'update', 'remove', 'list', 'find', 'audit'])
const identityKeys = [
  'runtimeSessionId',
  'sessionId',
  'projectId',
  'requestId',
  'toolCallId'
] as const
function key(request: Pick<RemoteLibraryRequest, (typeof identityKeys)[number]>): string {
  return JSON.stringify(identityKeys.map((field) => request[field]))
}
function parse(
  value: unknown,
  context: PhiHostRequestContext,
  cancel = false
): RemoteLibraryRequest {
  if (
    !rpcRecord(value) ||
    !identityKeys.every((field) => rpcIdentifier(value[field])) ||
    context.originSessionId !== value.runtimeSessionId ||
    context.toolCallId !== value.toolCallId ||
    Object.keys(value).some(
      (field) => ![...identityKeys, ...(cancel ? [] : ['action', 'input'])].includes(field)
    )
  )
    throw new RemoteLibraryError(
      'IDENTITY_MISMATCH',
      'Remote library request is not bound to its trusted tool scope'
    )
  if (
    !cancel &&
    (typeof value.action !== 'string' ||
      !actions.has(value.action) ||
      !rpcRecord(value.input) ||
      Buffer.byteLength(JSON.stringify(value.input)) > REMOTE_LIBRARY_MAX_REQUEST_BYTES)
  )
    throw new RemoteLibraryError(
      'LIMIT_EXCEEDED',
      'Remote library action/input is invalid or exceeds 256 KiB'
    )
  return structuredClone(value) as unknown as RemoteLibraryRequest
}
function string(input: Record<string, unknown>, field: string): string {
  if (typeof input[field] !== 'string' || !input[field].trim())
    throw new Error(`Missing required parameter: ${field}`)
  return input[field].trim()
}

/** Registers once in Node; the resolver owns actual selected project/host authority. */
export class RemoteLibraryService {
  private readonly active = new Map<string, AbortController>()
  private disposed = false
  constructor(
    private readonly resolveTarget: (
      identity: Readonly<RemoteLibraryIdentity>,
      signal: AbortSignal
    ) => RemoteLibraryTarget | Promise<RemoteLibraryTarget>
  ) {}
  async execute(value: unknown, context: PhiHostRequestContext): Promise<unknown> {
    if (this.disposed)
      throw new RemoteLibraryError('IDENTITY_MISMATCH', 'Remote library service disposed')
    const request = parse(value, context)
    const requestKey = key(request)
    if (this.active.has(requestKey) || this.active.size >= 64)
      throw new RemoteLibraryError(
        'IDENTITY_MISMATCH',
        'Remote library request is already active or capacity is exhausted'
      )
    const controller = new AbortController()
    this.active.set(requestKey, controller)
    let target: RemoteLibraryTarget | undefined
    let outcome: { ok: true; value: unknown } | { ok: false; error: unknown }
    try {
      target = await this.resolveTarget(
        Object.freeze({
          runtimeSessionId: request.runtimeSessionId,
          sessionId: request.sessionId,
          projectId: request.projectId
        }),
        controller.signal
      )
      controller.signal.throwIfAborted()
      outcome = { ok: true, value: await this.perform(request, target, controller.signal) }
    } catch (error) {
      outcome = { ok: false, error }
    }
    this.active.delete(requestKey)
    try {
      await target?.workspace.close?.()
    } catch (cause) {
      if (outcome.ok)
        throw new RemoteLibraryError(
          'STORAGE_FAILED',
          'Remote library workspace cleanup failed; inspect committed state before retrying',
          { cause }
        )
    }
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }
  private async perform(
    request: RemoteLibraryRequest,
    target: RemoteLibraryTarget,
    signal: AbortSignal
  ): Promise<unknown> {
    const storage = new RemoteLibraryStorage(target)
    const input = request.input
    switch (request.action) {
      case 'save':
        return await storage.mutate((index) => {
          const change = savePaperInIndex(index, input as SavePaperInput)
          return { ...change, key: change.result.paper.storageKey }
        }, signal)
      case 'update':
        return await storage.mutate((index) => {
          const change = updatePaperInIndex(
            index,
            string(input, 'id'),
            rpcRecord(input.patch) ? (input.patch as UpdatePaperInput) : {}
          )
          return { ...change, key: change.result.storageKey }
        }, signal)
      case 'remove':
        return await storage.mutate((index) => {
          const change = removePaperInIndex(index, string(input, 'id'))
          return { ...change, key: change.result.paper?.storageKey }
        }, signal)
      case 'list':
        return listPapersInIndex(await storage.read(signal), input as LibraryListFilters)
      case 'find':
        return findPapersInIndex(
          await storage.read(signal),
          typeof input.query === 'string' ? input.query : '',
          rpcRecord(input.filters) ? (input.filters as LibraryListFilters) : {}
        )
      case 'audit':
        return auditLibraryIndex(await storage.read(signal))
    }
  }
  cancel(value: unknown, context: PhiHostRequestContext): void {
    const request = parse(value, context, true)
    this.active.get(key(request))?.abort(new Error('Remote library request cancelled'))
  }
  dispose(): void {
    this.disposed = true
    for (const controller of this.active.values())
      controller.abort(new Error('Remote library service disposed'))
  }
}

/** Reuse library-tools' schemas, formatters and approval tiers; only storage routing changes. */
export function remoteLibraryToolStore(
  request: (method: string, params: unknown) => Promise<unknown>,
  identity: RemoteLibraryIdentity,
  toolCallId: () => string
): LibraryToolStoreFactory {
  return (_context, signal) => {
    const invoke = async (
      action: RemoteLibraryRequest['action'],
      input: Record<string, unknown>
    ): Promise<unknown> => {
      signal?.throwIfAborted()
      const binding = {
        runtimeSessionId: identity.runtimeSessionId,
        sessionId: identity.sessionId,
        projectId: identity.projectId,
        requestId: randomUUID(),
        toolCallId: toolCallId()
      }
      const cancel = (): void => {
        void request('library.cancel', binding).catch(() => undefined)
      }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        return await request('library.execute', { ...binding, action, input })
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
    }
    return {
      save: (input) =>
        invoke('save', input as Record<string, unknown>) as Promise<
          Awaited<ReturnType<LibraryToolStore['save']>>
        >,
      update: (id, patch) =>
        invoke('update', { id, patch }) as Promise<Awaited<ReturnType<LibraryToolStore['update']>>>,
      remove: (id) =>
        invoke('remove', { id }) as Promise<Awaited<ReturnType<LibraryToolStore['remove']>>>,
      list: (filters) =>
        invoke('list', filters as Record<string, unknown>) as Promise<
          Awaited<ReturnType<LibraryToolStore['list']>>
        >,
      find: (query, filters) =>
        invoke('find', { query, filters }) as Promise<
          Awaited<ReturnType<LibraryToolStore['find']>>
        >,
      audit: () => invoke('audit', {}) as Promise<Awaited<ReturnType<LibraryToolStore['audit']>>>
    }
  }
}
