import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import type { TerminalCommandDraft, TerminalSnapshot } from '../../shared/terminalTypes'
import { TerminalError } from './terminal-error'

const REQUEST_MAX_BYTES = 4 * 1024
const SELECTION_MAX_BYTES = 16 * 1024
const COMMAND_MAX_BYTES = 16 * 1024
const EXPLANATION_MAX_BYTES = 8 * 1024
const MAX_REQUIRED_INPUTS = 8
const MAX_DRAFTS = 32
const DRAFT_TTL_MS = 30 * 60 * 1_000
const SUBMIT_REQUEST_CAP = 1_024
const SUBMIT_REQUEST_TTL_MS = 10 * 60 * 1_000
const GENERATION_TIMEOUT_MS = 60 * 1_000
const INPUT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u

type MaybePromise<T> = T | Promise<T>

export interface TerminalDraftTargetSnapshot extends Pick<
  TerminalSnapshot,
  'terminalId' | 'workspaceKey' | 'initialCwd' | 'shell' | 'state'
> {
  workspaceLabel: string
}

export interface TerminalDraftManagerFacade {
  snapshot(terminalId: string): TerminalDraftTargetSnapshot | undefined
  input(terminalId: string, data: string): Promise<void>
}

export interface TerminalDraftSessionContext {
  terminalId: string
  workspaceKey: string
  cwd: string
}

export interface TerminalDraftSession {
  prompt(text: string): Promise<void>
  assistantText(): string
  abort(): Promise<void>
  dispose(): Promise<void>
}

export type TerminalDraftSessionFactory = (
  context: TerminalDraftSessionContext
) => MaybePromise<TerminalDraftSession>

export interface TerminalDraftServiceOptions {
  createSession: TerminalDraftSessionFactory
  manager: TerminalDraftManagerFacade
  now?: () => number
  generationTimeoutMs?: number
  randomDraftId?: () => string
}

export interface TerminalDraftGenerationInput {
  requestId: string
  terminalId: string
  kind: 'command' | 'explain'
  request: string
  selection?: string
}

export interface TerminalDraftGenerationResult extends TerminalCommandDraft {
  selectionTruncated?: boolean
}

export interface TerminalDraftSubmitInput {
  requestId: string
  draftId: string
  source: string
  bracketedPaste: boolean
}

interface ParsedDraft {
  command: string
  explanation: string
  requiredInputs: Array<{ name: string; description: string }>
}

interface StoredDraft extends TerminalCommandDraft {
  submitted: boolean
  createdAt: number
  lastUsedAt: number
}

interface SubmitRequestEntry {
  promise: Promise<void>
  settledAt?: number
}

interface ActiveGeneration {
  requestId: string
  terminalId: string
  cancelled: boolean
  timedOut: boolean
  session?: TerminalDraftSession
  abortPromise?: Promise<void>
  disposePromise?: Promise<void>
  rejectControl?: (error: TerminalError) => void
  promise?: Promise<TerminalDraftGenerationResult>
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function invalid(message: string): never {
  throw new TerminalError('invalid', message)
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && byteLength(value) <= maxBytes
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.byteLength <= maxBytes) return { text: value, truncated: false }

  let end = maxBytes
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1
  return { text: encoded.subarray(0, end).toString('utf8'), truncated: true }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function unwrapJsonFence(text: string): string {
  const trimmed = text.trim()
  const match = /^```json\s*\n([\s\S]*?)\n```$/iu.exec(trimmed)
  return match ? match[1].trim() : trimmed
}

export function parseTerminalDraftResponse(text: string): ParsedDraft {
  let decoded: unknown
  try {
    decoded = JSON.parse(unwrapJsonFence(text))
  } catch {
    return invalid('模型返回了无效的草稿')
  }

  const root = jsonObject(decoded)
  if (!root || !exactKeys(root, ['command', 'explanation', 'requiredInputs'])) {
    return invalid('模型返回了无效的草稿')
  }
  if (
    !boundedText(root.command, COMMAND_MAX_BYTES) ||
    !boundedText(root.explanation, EXPLANATION_MAX_BYTES) ||
    !Array.isArray(root.requiredInputs) ||
    root.requiredInputs.length > MAX_REQUIRED_INPUTS
  ) {
    return invalid('模型返回了无效的草稿')
  }

  const requiredInputs: ParsedDraft['requiredInputs'] = []
  const names = new Set<string>()
  for (const candidate of root.requiredInputs) {
    const item = jsonObject(candidate)
    if (
      !item ||
      !exactKeys(item, ['name', 'description']) ||
      typeof item.name !== 'string' ||
      !INPUT_NAME_PATTERN.test(item.name) ||
      typeof item.description !== 'string' ||
      names.has(item.name)
    ) {
      return invalid('模型返回了无效的草稿')
    }
    names.add(item.name)
    requiredInputs.push({ name: item.name, description: item.description })
  }

  const placeholders = new Set<string>()
  for (const match of root.command.matchAll(/<([^<>\r\n]+)>/gu)) {
    const name = match[1]
    if (!INPUT_NAME_PATTERN.test(name)) return invalid('模型返回了无效的草稿')
    placeholders.add(name)
  }
  if (
    [...placeholders].some((name) => !names.has(name)) ||
    [...names].some((name) => !placeholders.has(name))
  ) {
    return invalid('模型返回了无效的草稿')
  }

  return {
    command: root.command,
    explanation: root.explanation,
    requiredInputs
  }
}

export function buildTerminalDraftPrompt(input: {
  kind: 'command' | 'explain'
  request: string
  shell: string
  workspaceLabel: string
  initialCwd: string
  selection?: string
  selectionTruncated?: boolean
}): string {
  const context = {
    kind: input.kind,
    request: input.request,
    shell: input.shell,
    project: input.workspaceLabel,
    initialDirectory: input.initialCwd,
    platform: 'macOS',
    ...(input.selection !== undefined
      ? {
          selection: input.selection,
          ...(input.selectionTruncated ? { selectionNotice: 'truncated at 16 KiB' } : {})
        }
      : {})
  }

  return [
    'Create a terminal command draft from the user-provided context below.',
    'Return strict JSON only, with exactly this shape:',
    '{"command":string,"explanation":string,"requiredInputs":[{"name":string,"description":string}]}',
    'For explain requests, command may be an empty string.',
    'Write command placeholders as <name>. Every placeholder must have exactly one requiredInputs entry and every requiredInputs entry must appear in the command.',
    'Each input name must match ^[a-z][a-z0-9_]{0,31}$. Return at most 8 required inputs.',
    'Write the explanation and every input description in Simplified Chinese; keep the command itself unchanged.',
    'Do not use Markdown fences or include text outside the JSON object.',
    'User-provided context:',
    JSON.stringify(context)
  ].join('\n')
}

function cloneDraft(
  draft: StoredDraft,
  selectionTruncated?: boolean
): TerminalDraftGenerationResult {
  return {
    draftId: draft.draftId,
    terminalId: draft.terminalId,
    workspaceKey: draft.workspaceKey,
    source: draft.source,
    explanation: draft.explanation,
    requiredInputs: draft.requiredInputs.map((input) => ({ ...input })),
    ...(selectionTruncated ? { selectionTruncated: true } : {})
  }
}

export class TerminalDraftService {
  private readonly createSession: TerminalDraftSessionFactory
  private readonly manager: TerminalDraftManagerFacade
  private readonly now: () => number
  private readonly generationTimeoutMs: number
  private readonly randomDraftId: () => string
  private readonly drafts = new Map<string, StoredDraft>()
  private readonly submitRequests = new Map<string, SubmitRequestEntry>()
  private active?: ActiveGeneration
  private disposed = false
  private disposePromise?: Promise<void>

  constructor(options: TerminalDraftServiceOptions) {
    this.createSession = options.createSession
    this.manager = options.manager
    this.now = options.now ?? Date.now
    this.generationTimeoutMs = options.generationTimeoutMs ?? GENERATION_TIMEOUT_MS
    this.randomDraftId = options.randomDraftId ?? randomUUID
  }

  generate(input: TerminalDraftGenerationInput): Promise<TerminalDraftGenerationResult> {
    this.assertAvailable()
    if (this.active) {
      return Promise.reject(new TerminalError('busy', '已有草稿正在生成'))
    }
    if (!boundedText(input.request, REQUEST_MAX_BYTES)) {
      return Promise.reject(new TerminalError('invalid', '请输入有效的命令需求'))
    }
    if (input.selection !== undefined && typeof input.selection !== 'string') {
      return Promise.reject(new TerminalError('invalid', '附带内容无效'))
    }

    const target = { ...this.requireOpenTarget(input.terminalId) }
    const active: ActiveGeneration = {
      requestId: input.requestId,
      terminalId: input.terminalId,
      cancelled: false,
      timedOut: false
    }
    this.active = active
    const promise = this.performGeneration(active, target, input).finally(() => {
      if (this.active === active) this.active = undefined
    })
    active.promise = promise
    return promise
  }

  cancel(requestId: string): Promise<void> {
    const active = this.active
    if (!active || active.requestId !== requestId) return Promise.resolve()
    active.cancelled = true
    this.beginSessionTeardown(active)
    active.rejectControl?.(new TerminalError('unavailable', '生成已取消'))
    return Promise.resolve()
  }

  submit(input: TerminalDraftSubmitInput): Promise<void> {
    this.assertAvailable()
    this.pruneSubmitRequests()
    const cached = this.submitRequests.get(input.requestId)
    if (cached) return cached.promise
    if (this.submitRequests.size >= SUBMIT_REQUEST_CAP) {
      return Promise.reject(new TerminalError('busy', '发送请求过多，请稍后再试'))
    }

    // Publish the in-flight entry before validation or the PTY write starts so even a
    // re-entrant retry observes exactly the same result.
    const entry: SubmitRequestEntry = {
      promise: Promise.resolve().then(async () => await this.performSubmit(input))
    }
    this.submitRequests.set(input.requestId, entry)
    void entry.promise.then(
      () => {
        entry.settledAt = this.now()
      },
      () => {
        entry.settledAt = this.now()
      }
    )
    return entry.promise
  }

  terminalClosed(terminalId: string): void {
    for (const [draftId, draft] of this.drafts) {
      if (draft.terminalId === terminalId) this.drafts.delete(draftId)
    }
    const active = this.active
    if (active?.terminalId === terminalId) {
      active.cancelled = true
      this.beginSessionTeardown(active)
      active.rejectControl?.(new TerminalError('not_open', '目标终端已关闭'))
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.disposePromise = this.performDispose()
    return this.disposePromise
  }

  private async performGeneration(
    active: ActiveGeneration,
    target: TerminalDraftTargetSnapshot,
    input: TerminalDraftGenerationInput
  ): Promise<TerminalDraftGenerationResult> {
    let session: TerminalDraftSession | undefined
    let sessionPromise: Promise<TerminalDraftSession> | undefined
    const control = new Promise<never>((_resolve, reject) => {
      active.rejectControl = reject
    })
    const timer = setTimeout(() => {
      active.timedOut = true
      this.beginSessionTeardown(active)
      active.rejectControl?.(new TerminalError('unavailable', '生成超时'))
    }, this.generationTimeoutMs)

    try {
      sessionPromise = Promise.resolve().then(
        async () =>
          await this.createSession({
            terminalId: target.terminalId,
            workspaceKey: target.workspaceKey,
            cwd: target.initialCwd
          })
      )
      session = await Promise.race([sessionPromise, control])
      active.session = session
      if (active.cancelled) {
        this.beginSessionTeardown(active)
        throw new TerminalError('unavailable', '生成已取消')
      }

      const selection =
        input.selection === undefined
          ? undefined
          : truncateUtf8(input.selection, SELECTION_MAX_BYTES)
      const prompt = buildTerminalDraftPrompt({
        kind: input.kind,
        request: input.request,
        shell: basename(target.shell),
        workspaceLabel: target.workspaceLabel,
        initialCwd: target.initialCwd,
        ...(selection
          ? {
              selection: selection.text,
              ...(selection.truncated ? { selectionTruncated: true } : {})
            }
          : {})
      })
      const promptPromise = session.prompt(prompt)
      await Promise.race([promptPromise, control])
      const parsed = parseTerminalDraftResponse(session.assistantText())
      if (input.kind === 'command' && parsed.command.length === 0) {
        throw new TerminalError('invalid', '模型返回了无效的草稿')
      }
      const currentTarget = this.requireOpenTarget(target.terminalId)
      if (currentTarget.workspaceKey !== target.workspaceKey) {
        throw new TerminalError('invalid', '目标终端工作区已变化')
      }
      this.pruneDrafts()
      while (this.drafts.size >= MAX_DRAFTS) this.evictOldestDraft()
      const timestamp = this.now()
      const draft: StoredDraft = {
        draftId: this.randomDraftId(),
        terminalId: target.terminalId,
        workspaceKey: target.workspaceKey,
        source: parsed.command,
        explanation: parsed.explanation,
        requiredInputs: parsed.requiredInputs,
        submitted: false,
        createdAt: timestamp,
        lastUsedAt: timestamp
      }
      this.drafts.set(draft.draftId, draft)
      return cloneDraft(draft, selection?.truncated)
    } catch (error) {
      throw this.generationError(error, active)
    } finally {
      clearTimeout(timer)
      active.rejectControl = undefined
      if (session) {
        this.disposeGenerationSession(active)
      } else if (sessionPromise) {
        // Session construction itself is not abortable. If it completes after the
        // request timed out or was cancelled, tear the session down immediately.
        void sessionPromise.then(
          (lateSession) => {
            this.beginDetachedSessionTeardown(lateSession)
          },
          () => undefined
        )
      }
    }
  }

  private async performSubmit(input: TerminalDraftSubmitInput): Promise<void> {
    this.pruneDrafts()
    const draft = this.drafts.get(input.draftId)
    if (!draft) throw new TerminalError('invalid', '草稿不存在或已过期')
    draft.lastUsedAt = this.now()
    if (draft.submitted) throw new TerminalError('invalid', '该草稿已发送')
    if (typeof input.source !== 'string') throw new TerminalError('invalid', '命令内容无效')
    if (byteLength(input.source) > COMMAND_MAX_BYTES) {
      throw new TerminalError('invalid', '命令过长')
    }
    if (input.source.includes('\0')) throw new TerminalError('invalid', '命令包含无效字符')
    // A literal paste-end marker would close bracketed paste early and run the remainder line by line.
    if (input.source.includes('\x1b[201~')) throw new TerminalError('invalid', '命令包含无效字符')
    if (draft.requiredInputs.some((item) => input.source.includes(`<${item.name}>`))) {
      throw new TerminalError('invalid', '请填写所有必填项')
    }

    const target = this.manager.snapshot(draft.terminalId)
    if (!target || target.state !== 'open') {
      throw new TerminalError('not_open', '目标终端不可用')
    }
    if (target.workspaceKey !== draft.workspaceKey) {
      throw new TerminalError('invalid', '目标终端工作区已变化')
    }

    draft.submitted = true
    const source = input.bracketedPaste ? `\x1b[200~${input.source}\x1b[201~` : input.source
    try {
      await this.manager.input(draft.terminalId, `${source}\r`)
    } catch (error) {
      // These codes are raised before any byte reaches the PTY, so the draft may be sent again.
      if (error instanceof TerminalError && (error.code === 'not_open' || error.code === 'invalid')) {
        draft.submitted = false
      }
      if (error instanceof TerminalError) throw error
      throw new TerminalError('unavailable', '无法发送命令')
    }
  }

  private generationError(error: unknown, active: ActiveGeneration): TerminalError {
    if (active.timedOut) return new TerminalError('unavailable', '生成超时')
    if (active.cancelled) return new TerminalError('unavailable', '生成已取消')
    if (error instanceof TerminalError) return error
    return new TerminalError('unavailable', '无法生成草稿')
  }

  private requireOpenTarget(terminalId: string): TerminalDraftTargetSnapshot {
    const target = this.manager.snapshot(terminalId)
    if (!target) throw new TerminalError('not_found', '目标终端不存在')
    if (target.state !== 'open') throw new TerminalError('not_open', '目标终端不可用')
    return target
  }

  private pruneDrafts(): void {
    const now = this.now()
    for (const [draftId, draft] of this.drafts) {
      if (now - draft.lastUsedAt >= DRAFT_TTL_MS) this.drafts.delete(draftId)
    }
  }

  private evictOldestDraft(): void {
    let oldest: StoredDraft | undefined
    for (const draft of this.drafts.values()) {
      if (!oldest || draft.lastUsedAt < oldest.lastUsedAt) oldest = draft
    }
    if (oldest) this.drafts.delete(oldest.draftId)
  }

  private pruneSubmitRequests(): void {
    const now = this.now()
    for (const [requestId, entry] of this.submitRequests) {
      if (entry.settledAt !== undefined && now - entry.settledAt >= SUBMIT_REQUEST_TTL_MS) {
        this.submitRequests.delete(requestId)
      }
    }
  }

  private async performDispose(): Promise<void> {
    const active = this.active
    if (active) {
      active.cancelled = true
      this.beginSessionTeardown(active)
      active.rejectControl?.(new TerminalError('unavailable', '生成已取消'))
      await active.promise?.catch(() => undefined)
    }
    this.drafts.clear()
    this.submitRequests.clear()
  }

  private beginSessionTeardown(active: ActiveGeneration): void {
    // Runtime teardown hooks may never settle. Invoke both exactly once, but keep
    // their observed promises off the user-visible generation/disposal path.
    this.abortGeneration(active)
    this.disposeGenerationSession(active)
  }

  private beginDetachedSessionTeardown(session: TerminalDraftSession): void {
    this.observeSessionOperation(() => session.abort())
    this.observeSessionOperation(() => session.dispose())
  }

  private abortGeneration(active: ActiveGeneration): void {
    const session = active.session
    if (!session || active.abortPromise) return
    active.abortPromise = this.observeSessionOperation(() => session.abort())
  }

  private disposeGenerationSession(active: ActiveGeneration): void {
    const session = active.session
    if (!session || active.disposePromise) return
    active.disposePromise = this.observeSessionOperation(() => session.dispose())
  }

  private observeSessionOperation(operation: () => Promise<void>): Promise<void> {
    try {
      return Promise.resolve(operation()).catch(() => undefined)
    } catch {
      return Promise.resolve()
    }
  }

  private assertAvailable(): void {
    if (this.disposed) throw new TerminalError('unavailable', '草稿服务不可用')
  }
}
