import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'

import {
  isMissingFile,
  syncDirectory,
  writeJsonAtomic
} from '../agent/engine/kernel-history/atomic-file'

const MAX_IDENTIFIER_BYTES = 200
const MAX_TEXT_BYTES = 64 * 1024
const MAX_ENTRIES = 256
const MAX_FILE_BYTES = 8 * 1024 * 1024
// A queued entry can grow by an attempt UUID and the longest terminal status.
const RESERVED_TRANSITION_BYTES = 128

const identifier = z
  .string()
  .max(MAX_IDENTIFIER_BYTES)
  .refine((value) => value.trim().length > 0 && Buffer.byteLength(value) <= MAX_IDENTIFIER_BYTES)
const promptText = z
  .string()
  .max(MAX_TEXT_BYTES)
  .refine((value) => value.trim().length > 0 && Buffer.byteLength(value) <= MAX_TEXT_BYTES)
const scopeSchema = z.strictObject({
  conversationId: identifier,
  projectId: identifier.nullable()
})
const settledStatuses = ['succeeded', 'failed', 'cancelled'] as const
const uuid = z.uuid().refine((value) => value === value.toLowerCase())
const entrySchema = z.strictObject({
  id: uuid,
  requestId: identifier,
  scope: scopeSchema,
  text: promptText,
  order: z.int().nonnegative(),
  status: z.enum(['queued', 'running', 'interrupted', ...settledStatuses]),
  attemptId: uuid.optional()
})
const snapshotSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(entrySchema).max(MAX_ENTRIES)
})
const settleSchema = z.enum(settledStatuses)

export type AssistantInboxScope = Readonly<z.infer<typeof scopeSchema>>
export type AssistantInboxEntry = Readonly<
  Omit<z.infer<typeof entrySchema>, 'scope'> & { scope: AssistantInboxScope }
>
type ClaimedEntry = AssistantInboxEntry & { status: 'running'; attemptId: string }
type SettleResult = z.infer<typeof settleSchema>

interface AssistantInbox {
  submit(scope: AssistantInboxScope, requestId: string, text: string): Promise<AssistantInboxEntry>
  list(scope: AssistantInboxScope): Promise<readonly AssistantInboxEntry[]>
  claim(scope: AssistantInboxScope, attemptId: string): Promise<ClaimedEntry | null>
  settle(
    scope: AssistantInboxScope,
    id: string,
    attemptId: string,
    result: SettleResult
  ): Promise<boolean>
  cancel(scope: AssistantInboxScope, id: string): Promise<boolean>
  recover(): Promise<number>
}

function validateScope(value: AssistantInboxScope): AssistantInboxScope {
  const parsed = scopeSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid assistant inbox scope.')
  return parsed.data
}

function sameScope(left: AssistantInboxScope, right: AssistantInboxScope): boolean {
  return left.conversationId === right.conversationId && left.projectId === right.projectId
}

function invalidSnapshot(): Error {
  return new Error('Invalid or inaccessible assistant inbox snapshot.')
}

function parseSnapshot(bytes: Uint8Array): AssistantInboxEntry[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const snapshot = snapshotSchema.parse(JSON.parse(text))
  const ids = new Set<string>()
  const requests = new Set<string>()
  const attempts = new Set<string>()
  const runningScopes = new Set<string>()
  let previousOrder = -1
  for (const entry of snapshot.entries) {
    const scopeKey = JSON.stringify([entry.scope.conversationId, entry.scope.projectId])
    const requestKey = JSON.stringify([scopeKey, entry.requestId])
    if (entry.order <= previousOrder || ids.has(entry.id) || requests.has(requestKey)) {
      throw invalidSnapshot()
    }
    previousOrder = entry.order
    ids.add(entry.id)
    requests.add(requestKey)

    // Only cancellation can be recorded either before or after a claim.
    if (
      entry.status === 'queued' ? entry.attemptId : entry.status !== 'cancelled' && !entry.attemptId
    ) {
      throw invalidSnapshot()
    }
    if (entry.attemptId) {
      if (attempts.has(entry.attemptId)) throw invalidSnapshot()
      attempts.add(entry.attemptId)
    }
    if (entry.status === 'running') {
      if (runningScopes.has(scopeKey)) throw invalidSnapshot()
      runningScopes.add(scopeKey)
    }
  }
  return snapshot.entries
}

function isPrivate(mode: number): boolean {
  return process.platform === 'win32' || (mode & 0o077) === 0
}

async function readSnapshotBytes(handle: FileHandle, size: number): Promise<Uint8Array> {
  const buffer = Buffer.alloc(size + 1)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset !== size) throw invalidSnapshot()
  return buffer.subarray(0, offset)
}

async function readSnapshot(path: string): Promise<AssistantInboxEntry[]> {
  let metadata: Awaited<ReturnType<typeof lstat>>
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }
  if (!metadata.isFile() || metadata.nlink !== 1 || !isPrivate(metadata.mode)) {
    throw invalidSnapshot()
  }

  const flags =
    constants.O_RDONLY |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const handle = await open(path, flags)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.ino !== metadata.ino ||
      opened.dev !== metadata.dev ||
      opened.nlink !== 1 ||
      !isPrivate(opened.mode) ||
      opened.size > MAX_FILE_BYTES
    ) {
      throw invalidSnapshot()
    }
    return parseSnapshot(await readSnapshotBytes(handle, opened.size))
  } finally {
    await handle.close()
  }
}

class FileAssistantInbox implements AssistantInbox {
  private readonly path: string
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly root: string) {
    this.path = join(root, 'assistant-inbox.json')
  }

  private withSnapshot<T>(
    operation: (entries: AssistantInboxEntry[]) => T | Promise<T>
  ): Promise<T> {
    const pending = this.tail.then(async () => {
      let entries: AssistantInboxEntry[]
      try {
        const metadata = await lstat(this.root)
        if (!metadata.isDirectory() || !isPrivate(metadata.mode)) throw invalidSnapshot()
        entries = await readSnapshot(this.path)
        // An earlier write may have reached rename and then failed directory sync.
        // Confirm the currently observed snapshot before returning a deduplicated receipt.
        await syncDirectory(this.root)
      } catch {
        throw invalidSnapshot()
      }
      return operation(entries)
    })
    this.tail = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  private async persist(entries: AssistantInboxEntry[], admission = false): Promise<void> {
    const snapshot = { version: 1, entries }
    const bytes = Buffer.byteLength(JSON.stringify(snapshot, null, 2)) + 1
    const reserve = admission ? entries.length * RESERVED_TRANSITION_BYTES : 0
    if (entries.length > MAX_ENTRIES || bytes + reserve > MAX_FILE_BYTES) {
      throw new Error('Assistant inbox is full.')
    }
    try {
      await writeJsonAtomic(this.path, snapshot)
    } catch {
      throw new Error('Could not persist assistant inbox.')
    }
  }

  async submit(
    scope: AssistantInboxScope,
    requestId: string,
    text: string
  ): Promise<AssistantInboxEntry> {
    const target = validateScope(scope)
    if (!identifier.safeParse(requestId).success || !promptText.safeParse(text).success) {
      throw new Error('Invalid assistant inbox submission.')
    }
    return this.withSnapshot(async (entries) => {
      const previous = entries.find(
        (entry) => entry.requestId === requestId && sameScope(entry.scope, target)
      )
      if (previous) {
        if (previous.text !== text) throw new Error('Assistant inbox request conflict.')
        return previous
      }
      const order = (entries.at(-1)?.order ?? -1) + 1
      if (!Number.isSafeInteger(order)) throw new Error('Assistant inbox is full.')
      const entry = {
        id: randomUUID(),
        requestId,
        scope: target,
        text,
        order,
        status: 'queued'
      } as const
      entries.push(entry)
      await this.persist(entries, true)
      return entry
    })
  }

  async list(scope: AssistantInboxScope): Promise<readonly AssistantInboxEntry[]> {
    const target = validateScope(scope)
    return this.withSnapshot((entries) => entries.filter((entry) => sameScope(entry.scope, target)))
  }

  async claim(scope: AssistantInboxScope, attemptId: string): Promise<ClaimedEntry | null> {
    const target = validateScope(scope)
    if (!uuid.safeParse(attemptId).success) throw new Error('Invalid inbox attempt ID.')
    return this.withSnapshot(async (entries) => {
      // The caller retries the same attempt ID when persistence fails after rename.
      const previous = entries.find((entry) => entry.attemptId === attemptId)
      if (previous) {
        return previous.status === 'running' && sameScope(previous.scope, target)
          ? { ...previous, status: 'running', attemptId }
          : null
      }
      const scoped = entries.filter((entry) => sameScope(entry.scope, target))
      if (scoped.some((entry) => entry.status === 'running')) return null
      const next = scoped.find((entry) => entry.status === 'queued')
      if (!next) return null
      const claimed = { ...next, status: 'running', attemptId } as const
      await this.persist(entries.map((entry) => (entry.id === next.id ? claimed : entry)))
      return claimed
    })
  }

  async settle(
    scope: AssistantInboxScope,
    id: string,
    attemptId: string,
    result: SettleResult
  ): Promise<boolean> {
    const target = validateScope(scope)
    if (!settleSchema.safeParse(result).success) return false
    return this.withSnapshot(async (entries) => {
      const index = entries.findIndex(
        (entry) =>
          entry.id === id &&
          entry.status === 'running' &&
          entry.attemptId === attemptId &&
          sameScope(entry.scope, target)
      )
      const current = entries[index]
      if (!current) return false
      entries[index] = { ...current, status: result }
      await this.persist(entries)
      return true
    })
  }

  async cancel(scope: AssistantInboxScope, id: string): Promise<boolean> {
    const target = validateScope(scope)
    return this.withSnapshot(async (entries) => {
      const index = entries.findIndex(
        (entry) => entry.id === id && entry.status === 'queued' && sameScope(entry.scope, target)
      )
      const current = entries[index]
      if (!current) return false
      entries[index] = { ...current, status: 'cancelled' }
      await this.persist(entries)
      return true
    })
  }

  recover(): Promise<number> {
    return this.withSnapshot(async (entries) => {
      const next = entries.map((entry) =>
        entry.status === 'running' ? { ...entry, status: 'interrupted' as const } : entry
      )
      const count = entries.filter((entry) => entry.status === 'running').length
      if (count) await this.persist(next)
      return count
    })
  }
}

/** The caller supplies a private directory and guarantees one writer across processes. */
export function createAssistantInbox(directory: string): AssistantInbox {
  return new FileAssistantInbox(resolve(directory))
}
