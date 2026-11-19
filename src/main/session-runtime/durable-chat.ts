import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import type {
  ChatQueueItem,
  ChatQueueJobsSnapshot,
  ChatQueueJobsVersion,
  ChatQueueReceipt,
  ChatQueueTarget
} from '../../shared/chatQueueTypes'
import type { PromptImageInput } from '../../shared/promptImageTypes'
import type { WorkMode } from '../../shared/sessionMode'
import { validatePromptImages } from '../agent/session/prompt-images'
import { syncDirectory } from '../agent/engine/kernel-history/atomic-file'
import type { PromptRunDestination } from '../agent/session/prompt-target-control'
import {
  createAssistantInboxDispatch,
  type AssistantInboxDispatch
} from './assistant-inbox-dispatch'
import { tryAcquireAssistantInboxWriter } from './assistant-inbox-writer'
import { projectChatQueueJobs, type ChatQueueJobOwner } from './chat-queue-jobs'
import {
  createAssistantInbox,
  type AssistantInbox,
  type AssistantInboxEntry,
  type AssistantInboxScope,
  type ClaimedEntry,
  type SettleResult
} from './assistant-inbox'

const RESCAN_MS = 2_000
const requestIdSchema = z.uuidv4()
const targetSchema = z.object({
  path: z.string().min(1).max(8192).nullable(),
  phiSessionId: z.string().min(1).max(200).optional(),
  draftId: z.string().min(1).max(200).optional(),
  cwd: z.string().min(1).max(8192),
  sessionGeneration: z.int().nonnegative().optional(),
  images: z.unknown().optional(),
  retryUserMessageId: z.string().min(1).max(200).optional(),
  planMode: z.boolean().optional(),
  planExecute: z.boolean().optional()
})

export interface BoundChatQueueTarget extends PromptRunDestination {
  scope: AssistantInboxScope
  path: string
  binding: string
  sessionGeneration: number
  workMode: WorkMode
}

export interface DurableChatOptions {
  directory: string
  bind(target: ChatQueueTarget, title: string): BoundChatQueueTarget | Promise<BoundChatQueueTarget>
  sessionDirectory(sessionId: string): string
  scope(sessionId: string): AssistantInboxScope | null
  jobOwner?(sessionId: string): ChatQueueJobOwner | null
  prepare(entry: AssistantInboxEntry): Promise<'ready' | 'wait' | 'invalid'>
  capacity(): number
  execute(entry: ClaimedEntry, images: PromptImageInput[]): Promise<SettleResult>
  recoverOutcome(entry: ClaimedEntry): Exclude<SettleResult, 'defer'>
  changed(sessionId: string): void
  jobsChanged?(version: ChatQueueJobsVersion): void
  log(error: unknown): void
}

export interface DurableChat {
  start(): Promise<void>
  activate(): void
  beginShutdown(): void
  shutdown(): Promise<void>
  pause(sessionId: string): () => void
  isPaused(sessionId: string): boolean
  removeConversation(sessionId: string): Promise<void>
  submit(text: unknown, target: unknown, id: unknown): Promise<ChatQueueReceipt>
  list(sessionId: unknown): Promise<ChatQueueItem[]>
  listJobs(): Promise<ChatQueueJobsSnapshot>
  cancel(sessionId: unknown, itemId: unknown): Promise<boolean>
}

function requireIdentifier(id: unknown): string {
  if (typeof id !== 'string' || !id.trim() || Buffer.byteLength(id) > 200) {
    throw new Error('Invalid assistant inbox identifier.')
  }
  return id
}

async function confirmSessionFile(path: string): Promise<void> {
  const flags =
    constants.O_RDWR |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const handle = await open(path, flags)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('Invalid Phi session file.')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(dirname(path))
  await syncDirectory(dirname(dirname(path)))
}

export function createDurableChat(options: DurableChatOptions): DurableChat {
  let lease: NonNullable<ReturnType<typeof tryAcquireAssistantInboxWriter>> | undefined
  let inbox: AssistantInbox | undefined
  let dispatch: AssistantInboxDispatch | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let opening: Promise<void> | undefined
  let closing = false
  let pendingQueue = true
  let acceptances = Promise.resolve()
  const pending = new Set<Promise<unknown>>()
  const paused = new Map<string, number>()
  const epoch = randomUUID()
  let notifiedRevision = -1

  function changed(sessionId: string): void {
    try {
      options.changed(sessionId)
    } catch (error) {
      options.log(error)
    }
    const revision = inbox?.revision
    if (revision === undefined || revision <= notifiedRevision) return
    notifiedRevision = revision
    try {
      options.jobsChanged?.({ epoch, revision })
    } catch (error) {
      options.log(error)
    }
  }

  async function confirmCompleted(
    entry: ClaimedEntry,
    status: SettleResult
  ): Promise<SettleResult> {
    if (status !== 'succeeded') return status
    try {
      const directory = options.sessionDirectory(entry.scope.conversationId)
      await confirmSessionFile(join(directory, 'messages.jsonl'))
      await confirmSessionFile(join(directory, 'manifest.json'))
      return status
    } catch (error) {
      options.log(error)
      return 'interrupted'
    }
  }

  async function openInbox(): Promise<void> {
    try {
      await mkdir(options.directory, { recursive: true, mode: 0o700 })
      if (closing) return
      const acquired = tryAcquireAssistantInboxWriter(options.directory)
      if (!acquired) throw new Error('Another Phi instance owns the assistant inbox.')
      lease = acquired
      await syncDirectory(dirname(options.directory))
      await syncDirectory(dirname(dirname(options.directory)))
      const store = createAssistantInbox(options.directory)
      await store.recover(async (entry) => {
        const status = options.recoverOutcome(entry)
        if (status !== 'succeeded') return status
        return (await confirmCompleted(entry, status)) === 'succeeded' ? 'succeeded' : 'interrupted'
      })
      if (closing) return
      dispatch = createAssistantInboxDispatch({
        inbox: {
          queued: async () => {
            const queued = await store.queued()
            pendingQueue = queued.length > 0
            return queued
          },
          claim: (...args) => store.claim(...args),
          settle: async (...args) => {
            const settled = await store.settle(...args)
            if (settled && args[3] === 'defer') pendingQueue = true
            return settled
          }
        },
        prepare: (entry) =>
          paused.has(entry.scope.conversationId) ? Promise.resolve('wait') : options.prepare(entry),
        capacity: options.capacity,
        execute: async (entry) => {
          let images: PromptImageInput[]
          try {
            images = entry.attachments?.length
              ? await store.loadImages(entry.scope, entry.id, entry.attemptId)
              : []
          } catch (error) {
            options.log(error)
            return 'failed'
          }
          if (closing || paused.has(entry.scope.conversationId)) return 'defer'
          return confirmCompleted(entry, await options.execute(entry, images))
        },
        changed,
        log: options.log
      })
      inbox = store
    } catch (error) {
      lease?.release()
      lease = undefined
      throw error
    }
  }

  function tracked<T>(work: (store: AssistantInbox) => Promise<T>): Promise<T> {
    if (!inbox || closing) return Promise.reject(new Error('Phi chat queue is unavailable.'))
    const result = work(inbox)
    pending.add(result)
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result)
    )
    return result
  }

  function beginShutdown(): void {
    closing = true
    clearInterval(timer)
    dispatch?.stop()
  }

  return {
    start: () => (opening ??= openInbox()),
    activate() {
      if (closing || !dispatch || timer) return
      dispatch.wake()
      timer = setInterval(() => {
        if (pendingQueue) dispatch?.wake()
      }, RESCAN_MS)
      timer.unref()
    },
    beginShutdown,
    async shutdown() {
      beginShutdown()
      await opening?.catch(() => undefined)
      await Promise.all([dispatch?.drained(), Promise.allSettled(pending)])
      lease?.release()
      lease = undefined
    },
    pause(sessionId) {
      paused.set(sessionId, (paused.get(sessionId) ?? 0) + 1)
      let held = true
      return () => {
        if (!held) return
        held = false
        const count = paused.get(sessionId)
        if (count === 1) {
          paused.delete(sessionId)
          dispatch?.wake()
        } else if (count) {
          paused.set(sessionId, count - 1)
        }
      }
    },
    isPaused: (sessionId) => paused.has(sessionId),
    async removeConversation(sessionId) {
      if (!inbox) return
      await tracked((store) => store.removeConversation(sessionId))
      changed(sessionId)
    },
    submit: (text, target, id) =>
      tracked(async (store) => {
        const requestId = requestIdSchema.parse(id)
        const message = typeof text === 'string' ? text.trim() : ''
        const parsed = targetSchema.parse(target)
        const images = validatePromptImages(parsed.images)
        if ((!message && !images.length) || Buffer.byteLength(message) > 64 * 1024) {
          throw new Error('Invalid assistant inbox submission.')
        }
        // Capture the target now, while the composer still owns it. Confirm and
        // publish in arrival order even when filesystem operations finish out of order.
        const bound = Promise.resolve(options.bind({ ...parsed, images }, message)).then(
          (destination) => ({ ok: true, destination }) as const,
          (error: unknown) => ({ ok: false, error }) as const
        )
        const accepted = acceptances.then(async () => {
          const resolved = await bound
          if (!resolved.ok) throw resolved.error
          const { destination } = resolved
          const sessionId = destination.scope.conversationId
          await confirmSessionFile(join(options.sessionDirectory(sessionId), 'manifest.json'))
          if (
            paused.has(sessionId) ||
            options.scope(sessionId)?.projectId !== destination.scope.projectId
          ) {
            throw new Error('会话已删除或正在删除')
          }
          const entry = await store.submit(destination.scope, requestId, message, {
            images,
            mode: destination.workMode === 'plan_execute' ? 'plan-execute' : destination.workMode,
            binding: destination.binding,
            retryUserMessageId: parsed.retryUserMessageId
          })
          pendingQueue = true
          changed(sessionId)
          dispatch?.wake()
          return {
            id: entry.id,
            sessionId,
            path: destination.path,
            sessionGeneration: destination.sessionGeneration
          }
        })
        acceptances = accepted.then(
          () => undefined,
          () => undefined
        )
        return accepted
      }),
    list: (id) =>
      tracked(async (store) => {
        const scope = options.scope(requireIdentifier(id))
        return (scope ? await store.list(scope) : []).map((entry) => ({
          id: entry.id,
          text: entry.text,
          status: entry.status,
          imageCount: entry.attachments?.length ?? 0
        }))
      }),
    listJobs: () =>
      tracked(async (store) => {
        const { revision, entries } = await store.snapshot()
        const owner = options.jobOwner ?? ((id: string) => options.scope(id))
        return { epoch, revision, items: projectChatQueueJobs(entries, owner) }
      }),
    cancel: (sessionId, itemId) =>
      tracked(async (store) => {
        const id = requireIdentifier(sessionId)
        const scope = options.scope(id)
        if (!scope) return false
        const entryId = requireIdentifier(itemId)
        const cancelled = await store.cancel(scope, entryId).catch(async (error: unknown) => {
          // A rename can have succeeded before confirmation reached the caller.
          const entry = (await store.list(scope)).find((item) => item.id === entryId)
          if (entry?.status === 'cancelled' && !entry.attemptId) return true
          throw error
        })
        if (cancelled) {
          changed(id)
          dispatch?.wake()
        }
        return cancelled
      })
  }
}
