import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, unlink, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'

import {
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGE_BYTES,
  type PromptImageInput
} from '../../shared/promptImageTypes'
import {
  isMissingFile,
  syncDirectory,
  writeJsonAtomic
} from '../agent/engine/kernel-history/atomic-file'
import {
  createAssistantInboxAttachments,
  prepareAssistantInboxAttachments,
  type AssistantInboxAttachment
} from './assistant-inbox-attachments'

const SNAPSHOT_FILE = 'assistant-inbox.json'
const SNAPSHOT_TEMP =
  /^assistant-inbox\.json\.tmp\.\d+\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const MAX_IDENTIFIER_BYTES = 200
const MAX_TEXT_BYTES = 64 * 1024
const MAX_ENTRIES = 256
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024
// A queued entry can grow by an attempt UUID and the longest terminal status.
const RESERVED_TRANSITION_BYTES = 128

const identifier = z
  .string()
  .max(MAX_IDENTIFIER_BYTES)
  .refine((value) => value.trim().length > 0 && Buffer.byteLength(value) <= MAX_IDENTIFIER_BYTES)
const promptText = z
  .string()
  .max(MAX_TEXT_BYTES)
  .refine((value) => Buffer.byteLength(value) <= MAX_TEXT_BYTES)
const scopeSchema = z.strictObject({
  conversationId: identifier,
  projectId: identifier.nullable()
})
const settledStatuses = ['succeeded', 'failed', 'cancelled'] as const
const uuid = z.uuid().refine((value) => value === value.toLowerCase())
const attachmentSchema = z.strictObject({
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  bytes: z.int().positive().max(MAX_PROMPT_IMAGE_BYTES)
})
const modeSchema = z.enum(['plan', 'plan-execute'])
const entrySchema = z
  .strictObject({
    id: uuid,
    requestId: identifier,
    scope: scopeSchema,
    text: promptText,
    order: z.int().nonnegative(),
    status: z.enum(['queued', 'running', 'interrupted', ...settledStatuses]),
    attemptId: uuid.optional(),
    attachments: z.array(attachmentSchema).min(1).max(MAX_PROMPT_IMAGES).optional(),
    mode: modeSchema.optional()
  })
  .refine((entry) => Boolean(entry.text.trim() || entry.attachments?.length))
const snapshotSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(entrySchema).max(MAX_ENTRIES)
})
const settleSchema = z.enum(settledStatuses)

export type AssistantInboxScope = Readonly<z.infer<typeof scopeSchema>>
export type AssistantInboxEntry = Readonly<
  Omit<z.infer<typeof entrySchema>, 'scope' | 'attachments'> & {
    scope: AssistantInboxScope
    attachments?: readonly AssistantInboxAttachment[]
  }
>
type ClaimedEntry = AssistantInboxEntry & { status: 'running'; attemptId: string }
type SettleResult = z.infer<typeof settleSchema>
type SubmissionOptions = {
  images?: readonly PromptImageInput[]
  mode?: z.infer<typeof modeSchema>
}

interface AssistantInbox {
  submit(
    scope: AssistantInboxScope,
    requestId: string,
    text: string,
    options?: SubmissionOptions
  ): Promise<AssistantInboxEntry>
  list(scope: AssistantInboxScope): Promise<readonly AssistantInboxEntry[]>
  claim(scope: AssistantInboxScope, attemptId: string): Promise<ClaimedEntry | null>
  loadImages(scope: AssistantInboxScope, id: string, attemptId: string): Promise<PromptImageInput[]>
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

function retainsAttachments(entry: AssistantInboxEntry): boolean {
  return entry.status !== 'succeeded' && entry.status !== 'cancelled'
}

function attachmentSizes(entries: readonly AssistantInboxEntry[]): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const entry of entries) {
    if (!retainsAttachments(entry)) continue
    for (const { digest, bytes } of entry.attachments ?? []) {
      const previous = sizes.get(digest)
      if (previous !== undefined && previous !== bytes) throw invalidSnapshot()
      sizes.set(digest, bytes)
    }
  }
  return sizes
}

function totalAttachmentBytes(sizes: ReadonlyMap<string, number>): number {
  let total = 0
  for (const bytes of sizes.values()) total += bytes
  return total
}

function sameAttachments(
  left: readonly AssistantInboxAttachment[] = [],
  right: readonly AssistantInboxAttachment[]
): boolean {
  return (
    left.length === right.length &&
    left.every((ref, index) => {
      const other = right[index]
      return (
        ref.digest === other.digest && ref.mimeType === other.mimeType && ref.bytes === other.bytes
      )
    })
  )
}

function captureImages(images: SubmissionOptions['images']): PromptImageInput[] | undefined {
  if (images === undefined) return undefined
  if (!Array.isArray(images) || images.length > MAX_PROMPT_IMAGES) {
    throw new Error('Invalid assistant inbox submission.')
  }
  return Array.from(images, (image) => {
    if (!image || typeof image !== 'object') throw new Error('Invalid assistant inbox submission.')
    return { mimeType: image.mimeType, data: image.data }
  })
}

function parseSnapshot(bytes: Uint8Array): AssistantInboxEntry[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const snapshot = snapshotSchema.parse(JSON.parse(text))
  if (totalAttachmentBytes(attachmentSizes(snapshot.entries)) > MAX_ATTACHMENT_BYTES) {
    throw invalidSnapshot()
  }
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
  private readonly attachments: ReturnType<typeof createAssistantInboxAttachments>
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly root: string) {
    this.path = join(root, SNAPSHOT_FILE)
    this.attachments = createAssistantInboxAttachments(root)
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

  private checkCapacity(entries: AssistantInboxEntry[], reserve: number): void {
    const bytes = Buffer.byteLength(JSON.stringify({ version: 1, entries }, null, 2)) + 1
    if (entries.length > MAX_ENTRIES || bytes + reserve > MAX_FILE_BYTES) {
      throw new Error('Assistant inbox is full.')
    }
  }

  private async persist(entries: AssistantInboxEntry[], admission = false): Promise<void> {
    this.checkCapacity(entries, admission ? entries.length * RESERVED_TRANSITION_BYTES : 0)
    try {
      await writeJsonAtomic(this.path, { version: 1, entries })
    } catch {
      throw new Error('Could not persist assistant inbox.')
    }
  }

  private async persistSubmission(
    entries: AssistantInboxEntry[],
    entry: AssistantInboxEntry,
    images: ReturnType<typeof prepareAssistantInboxAttachments>
  ): Promise<void> {
    const next = [...entries, entry]
    if (images.length === 0) return this.persist(next, true)
    if (totalAttachmentBytes(attachmentSizes(next)) > MAX_ATTACHMENT_BYTES) {
      throw new Error('Assistant inbox attachment storage is full.')
    }
    this.checkCapacity(next, next.length * RESERVED_TRANSITION_BYTES)
    await this.sweepAttachments(entries)
    try {
      await this.attachments.stage(images)
      await this.persist(next, true)
    } catch (error) {
      // Publication may have succeeded before an error syncing the directory.
      // Sweep only from the snapshot that reopening confirms is durable.
      await this.confirmThenSweep().catch(() => undefined)
      throw error
    }
  }

  async submit(
    scope: AssistantInboxScope,
    requestId: string,
    text: string,
    options: SubmissionOptions = {}
  ): Promise<AssistantInboxEntry> {
    const target = validateScope(scope)
    const mode = modeSchema.optional().safeParse(options.mode)
    if (
      !identifier.safeParse(requestId).success ||
      !promptText.safeParse(text).success ||
      !mode.success
    ) {
      throw new Error('Invalid assistant inbox submission.')
    }
    const images = captureImages(options.images)
    return this.withSnapshot(async (entries) => {
      const prepared = prepareAssistantInboxAttachments(images)
      const refs = prepared.map((image) => image.ref)
      if (!text.trim() && refs.length === 0) throw new Error('Invalid assistant inbox submission.')
      const previous = entries.find(
        (entry) => entry.requestId === requestId && sameScope(entry.scope, target)
      )
      if (previous) {
        if (
          previous.text !== text ||
          previous.mode !== mode.data ||
          !sameAttachments(previous.attachments, refs)
        ) {
          throw new Error('Assistant inbox request conflict.')
        }
        if (prepared.length && retainsAttachments(previous)) await this.attachments.stage(prepared)
        return previous
      }
      const order = (entries.at(-1)?.order ?? -1) + 1
      if (!Number.isSafeInteger(order)) throw new Error('Assistant inbox is full.')
      const entry = {
        id: randomUUID(),
        requestId,
        scope: target,
        text,
        ...(refs.length ? { attachments: refs } : {}),
        ...(mode.data ? { mode: mode.data } : {}),
        order,
        status: 'queued'
      } as const
      await this.persistSubmission(entries, entry, prepared)
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

  async loadImages(
    scope: AssistantInboxScope,
    id: string,
    attemptId: string
  ): Promise<PromptImageInput[]> {
    const target = validateScope(scope)
    return this.withSnapshot((entries) => {
      const entry = entries.find(
        (entry) =>
          entry.id === id &&
          entry.status === 'running' &&
          entry.attemptId === attemptId &&
          sameScope(entry.scope, target)
      )
      if (!entry) throw new Error('Assistant inbox attempt is no longer active.')
      return this.attachments.load(entry.attachments ?? [])
    })
  }

  async settle(
    scope: AssistantInboxScope,
    id: string,
    attemptId: string,
    result: SettleResult
  ): Promise<boolean> {
    const target = validateScope(scope)
    if (!uuid.safeParse(attemptId).success || !settleSchema.safeParse(result).success) return false
    return this.withSnapshot(async (entries) => {
      const index = entries.findIndex(
        (entry) =>
          entry.id === id && entry.attemptId === attemptId && sameScope(entry.scope, target)
      )
      const current = entries[index]
      if (!current || (current.status !== 'running' && current.status !== result)) return false
      if (current.status === result) return true
      entries[index] = { ...current, status: result }
      await this.persist(entries)
      if (result !== 'failed' && current.attachments) {
        await this.sweepAttachments(entries).catch(() => undefined)
      }
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
      if (current.attachments) await this.sweepAttachments(entries).catch(() => undefined)
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
      await this.sweepAttachments(next)
      await this.sweepSnapshotTemps()
      return count
    })
  }

  private sweepAttachments(entries: readonly AssistantInboxEntry[]): Promise<void> {
    return this.attachments.sweep(new Set(attachmentSizes(entries).keys()))
  }

  private async confirmThenSweep(): Promise<void> {
    const entries = await readSnapshot(this.path)
    await syncDirectory(this.root)
    await this.sweepAttachments(entries)
  }

  private async sweepSnapshotTemps(): Promise<void> {
    const files = await readdir(this.root, { withFileTypes: true })
    for (const file of files) {
      if (file.isFile() && SNAPSHOT_TEMP.test(file.name)) {
        const path = join(this.root, file.name)
        const info = await lstat(path)
        if (info.isFile() && info.nlink === 1 && isPrivate(info.mode)) await unlink(path)
      }
    }
    await syncDirectory(this.root)
  }
}

/** The caller supplies a private directory and guarantees one writer across processes. */
export function createAssistantInbox(directory: string): AssistantInbox {
  return new FileAssistantInbox(resolve(directory))
}
