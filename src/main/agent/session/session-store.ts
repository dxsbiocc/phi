import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'

import type { ProjectLocation } from '../../../shared/projectLocation'
import type { AutoCompactionOverrides } from '../../../shared/contextUsageTypes'
import { messageContentTitleText } from '../../../shared/sessionTitle'
import { fieldsFromMode, modeFromFields, type WorkMode } from '../../../shared/sessionMode'
import { getPhiAgentDir } from '../runtime-paths'
import { readManifestFile, writeManifestFile } from './manifest-file'
import {
  createRuntimeReferenceAdoption,
  type RuntimeReferenceAdoption,
  type RuntimeReferenceAdoptionOptions
} from './runtime-reference-adoption'
import {
  assertLocalRuntimeAccess,
  kernelForkAccess,
  assertKernelRuntimeReferenceProject,
  parseKernelRuntimeReference,
  type KernelRuntimeRef,
  type PhiRuntimeRef,
  type RemoteOmpScope,
  type RuntimeRecoveryDiagnostic
} from './runtime-reference'

export { toolResultDetailsForSession } from './tool-result-details'

export type SessionKind = 'ordinary' | 'project'
export type SessionStatus =
  'idle' | 'running' | 'needs_approval' | 'needs_input' | 'failed' | 'completed_unread'
export type UnreadKind = 'completed' | 'failed' | 'approval' | 'input'
export type PermissionMode = 'auto' | 'ask' | 'full'
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type LastRunOutcome = 'completed' | 'failed' | 'interrupted' | 'stopped'

export interface ModelSelection {
  providerId: string
  modelId: string
}

export interface PhiSessionManifest {
  schemaVersion: 1
  sessionId: string
  kind: SessionKind
  projectId: string | null
  projectLocation?: ProjectLocation
  cwd: string
  cwdRealPath: string
  title?: string
  titleSource?: 'auto' | 'user'
  forkedFrom?: { sessionId: string; eventId: string }
  runtimeSessionPath?: string
  /** Marks a newly-created SSH session before its first concrete RPC runtimeRef is adopted. */
  remoteRuntime?: 'rpc'
  runtimeRef?: PhiRuntimeRef
  /** K4 kernel identity; unlike the RPC-era runtimeRef this applies to local and SSH sessions. */
  kernelRuntimeRef?: KernelRuntimeRef
  readonly runtimeRecoveryError?: RuntimeRecoveryDiagnostic
  permissionMode: PermissionMode
  workMode?: WorkMode
  model?: ModelSelection | null
  thinkingLevel?: ThinkingLevel
  autoCompaction?: AutoCompactionOverrides
  status: SessionStatus
  unreadKind: UnreadKind | null
  currentRunId?: string
  lastRunOutcome?: LastRunOutcome
  lastEventType?: string
  messageCount: number
  currentRunStartedAt?: string
  /** Tool calls whose agent executions have started but not completed in this session. */
  openAgentExecutions?: string[]
  createdAt: string
  updatedAt: string
  lastActivityAt: string
}

export interface CreatePhiSessionInput {
  kind: SessionKind
  projectId?: string | null
  projectLocation?: ProjectLocation
  cwd: string
  cwdRealPath: string
  title?: string
  forkedFrom?: { sessionId: string; eventId: string }
  runtimeSessionPath?: string
  remoteRuntime?: 'rpc'
  permissionMode: PermissionMode
  workMode?: WorkMode
  model?: ModelSelection | null
  thinkingLevel?: ThinkingLevel
  autoCompaction?: AutoCompactionOverrides
}

export type SessionEventInput = Record<string, unknown> & {
  type: string
  runId?: string
}

export type StoredSessionEvent = SessionEventInput & {
  eventId: string
  sessionId: string
  createdAt: string
}

export interface PhiSessionRecord {
  sessionId: string
  dir: string
  manifest: PhiSessionManifest
}

const MANIFEST_FILE = 'manifest.json'
const MESSAGES_FILE = 'messages.jsonl'
const SESSIONS_DIR = 'sessions'
const TOOL_OUTPUTS_DIR = 'tool-outputs'
const ARTIFACTS_DIR = 'artifacts'
const DEFAULT_INLINE_TOOL_OUTPUT_CHARS = 20000
const PROMPT_IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

function nowIso(): string {
  return new Date().toISOString()
}

function validIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return Number.isFinite(Date.parse(value)) ? value : undefined
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function assertSafeSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error('Invalid session id')
  }
}

export function createRunId(): string {
  return randomUUID()
}

export function getPhiSessionsDir(agentDir = getPhiAgentDir()): string {
  return join(agentDir, SESSIONS_DIR)
}

export function getSessionDir(sessionId: string, agentDir = getPhiAgentDir()): string {
  assertSafeSessionId(sessionId)
  return join(getPhiSessionsDir(agentDir), sessionId)
}

function getManifestPath(sessionId: string): string {
  return join(getSessionDir(sessionId), MANIFEST_FILE)
}

function getMessagesPath(sessionId: string): string {
  return join(getSessionDir(sessionId), MESSAGES_FILE)
}

function getToolOutputsDir(sessionId: string): string {
  return join(getSessionDir(sessionId), TOOL_OUTPUTS_DIR)
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'output'
}

function readManifest(sessionId: string): PhiSessionManifest {
  const manifestPath = getManifestPath(sessionId)
  if (!existsSync(manifestPath)) {
    throw new Error(`Session manifest not found: ${sessionId}`)
  }
  return readManifestFile(manifestPath, sessionId)
}

function writeManifest(manifest: PhiSessionManifest): void {
  const dir = getSessionDir(manifest.sessionId)
  ensureDir(dir)
  writeManifestFile(dir, manifest)
}

function withoutUndefinedOptionalFields(manifest: PhiSessionManifest): PhiSessionManifest {
  const next = { ...manifest } as PhiSessionManifest & Record<string, unknown>
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key]
  }
  return next
}

export function createPhiSession(input: CreatePhiSessionInput): PhiSessionRecord {
  if (input.projectLocation?.kind === 'ssh' && (input.kind !== 'project' || !input.projectId)) {
    throw new Error('远程项目会话必须绑定项目 ID')
  }
  const sessionId = randomUUID()
  const dir = getSessionDir(sessionId)
  const timestamp = nowIso()
  const manifest: PhiSessionManifest = {
    schemaVersion: 1,
    sessionId,
    kind: input.kind,
    projectId: input.projectId ?? null,
    ...(input.projectLocation ? { projectLocation: input.projectLocation } : {}),
    cwd: input.cwd,
    cwdRealPath: input.cwdRealPath,
    ...(input.title ? { title: input.title } : {}),
    ...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}),
    ...(input.runtimeSessionPath ? { runtimeSessionPath: input.runtimeSessionPath } : {}),
    ...(input.remoteRuntime ? { remoteRuntime: input.remoteRuntime } : {}),
    permissionMode: input.permissionMode,
    workMode:
      input.workMode ??
      fieldsFromMode(modeFromFields({ permissionMode: input.permissionMode })).workMode,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.autoCompaction ? { autoCompaction: input.autoCompaction } : {}),
    status: 'idle',
    unreadKind: null,
    messageCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivityAt: timestamp
  }

  ensureDir(dir)
  ensureDir(join(dir, TOOL_OUTPUTS_DIR))
  ensureDir(join(dir, ARTIFACTS_DIR))
  writeManifest(manifest)
  writeFileSync(join(dir, MESSAGES_FILE), '', { flag: 'wx', encoding: 'utf-8' })

  return { sessionId, dir, manifest }
}

export interface PersistedToolOutput {
  outputPreview: string
  outputPath?: string
  outputBytes: number
  truncated: boolean
  outputArtifact?: {
    kind: 'tool_output'
    path: string
    bytes: number
  }
}

export function persistToolOutput(
  sessionId: string,
  input: {
    runId: string
    toolCallId: string
    output: string
    inlineLimit?: number
  }
): PersistedToolOutput {
  const outputBytes = Buffer.byteLength(input.output, 'utf-8')
  const inlineLimit = input.inlineLimit ?? DEFAULT_INLINE_TOOL_OUTPUT_CHARS
  if (input.output.length <= inlineLimit) {
    return {
      outputPreview: input.output,
      outputBytes,
      truncated: false
    }
  }

  const dir = getToolOutputsDir(sessionId)
  ensureDir(dir)
  const fileName = `${safePathPart(input.runId)}-${safePathPart(input.toolCallId)}.txt`
  const outputPath = join(dir, fileName)
  writeFileSync(outputPath, input.output, 'utf-8')
  return {
    outputPreview: `${input.output.slice(0, inlineLimit)}\n...（完整输出已保存到 ${outputPath}）`,
    outputPath,
    outputBytes,
    truncated: true,
    outputArtifact: {
      kind: 'tool_output',
      path: outputPath,
      bytes: outputBytes
    }
  }
}

export function updateSessionManifest(
  sessionId: string,
  patch: Partial<
    Omit<
      PhiSessionManifest,
      | 'schemaVersion'
      | 'sessionId'
      | 'createdAt'
      | 'runtimeRef'
      | 'kernelRuntimeRef'
      | 'runtimeRecoveryError'
    >
  >
): PhiSessionManifest {
  if (
    Object.hasOwn(patch, 'runtimeRef') ||
    Object.hasOwn(patch, 'kernelRuntimeRef') ||
    Object.hasOwn(patch, 'runtimeRecoveryError')
  ) {
    throw new Error('Runtime reference requires verified adoption')
  }
  const manifest = readManifest(sessionId)
  const updated: PhiSessionManifest = {
    ...manifest,
    ...patch,
    sessionId: manifest.sessionId,
    schemaVersion: manifest.schemaVersion,
    createdAt: manifest.createdAt,
    updatedAt: nowIso()
  }
  const normalized = withoutUndefinedOptionalFields(updated)
  writeManifest(normalized)
  return normalized
}

export function recordKernelRuntimeReference(
  sessionId: string,
  value: KernelRuntimeRef
): PhiSessionManifest {
  const manifest = readManifest(sessionId)
  const kernelRuntimeRef = parseKernelRuntimeReference(value)
  const candidate: PhiSessionManifest = withoutUndefinedOptionalFields({
    ...manifest,
    runtimeSessionPath: undefined,
    remoteRuntime: undefined,
    runtimeRef: undefined,
    kernelRuntimeRef,
    updatedAt: nowIso()
  })
  assertKernelRuntimeReferenceProject(candidate, kernelRuntimeRef)
  writeManifest(candidate)
  return candidate
}

/** Server publication and desktop adoption are separate commits, not a distributed transaction. */
export function beginRuntimeReferenceAdoption(
  sessionId: string,
  trustedScope: RemoteOmpScope,
  generation: string,
  options?: RuntimeReferenceAdoptionOptions
): RuntimeReferenceAdoption {
  return createRuntimeReferenceAdoption(
    getManifestPath(sessionId),
    sessionId,
    trustedScope,
    generation,
    {
      read: () => readManifest(sessionId),
      write: writeManifest
    },
    options
  )
}

function nextOpenAgentExecutions(
  current: string[] | undefined,
  event: SessionEventInput
): string[] | undefined {
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined
  if (!toolCallId) return current
  if (event.type === 'agent_execution_started') {
    const open = current ?? []
    return open.includes(toolCallId) ? open : [...open, toolCallId]
  }
  if (event.type === 'agent_execution_completed' && current !== undefined) {
    return current.filter((id) => id !== toolCallId)
  }
  return current
}

export function appendSessionEvent(
  sessionId: string,
  event: SessionEventInput
): StoredSessionEvent {
  const manifest = readManifest(sessionId)
  const writeTimestamp = nowIso()
  const eventTimestamp = validIsoTimestamp(event.createdAt) ?? writeTimestamp
  const stored: StoredSessionEvent = {
    ...event,
    eventId: randomUUID(),
    sessionId,
    createdAt: eventTimestamp
  }
  const openAgentExecutions = nextOpenAgentExecutions(manifest.openAgentExecutions, event)

  appendFileSync(getMessagesPath(sessionId), `${JSON.stringify(stored)}\n`, 'utf-8')
  writeManifest({
    ...manifest,
    ...(openAgentExecutions !== undefined ? { openAgentExecutions } : {}),
    messageCount: manifest.messageCount + 1,
    lastEventType: event.type,
    updatedAt: writeTimestamp,
    lastActivityAt: eventTimestamp
  })

  return stored
}

export function readSessionEvents(sessionId: string): StoredSessionEvent[] {
  const messagesPath = getMessagesPath(sessionId)
  if (!existsSync(messagesPath)) return []

  return readFileSync(messagesPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as StoredSessionEvent)
}

export function sessionDisplayTitleFromManifest(manifest: PhiSessionManifest): string {
  const title = messageContentTitleText(manifest.title)
  if (title) return title
  const firstUserMessage = readSessionEvents(manifest.sessionId).find(
    (event) => event.type === 'user_message' && typeof event.content === 'string'
  )
  return typeof firstUserMessage?.content === 'string'
    ? messageContentTitleText(firstUserMessage.content)
    : ''
}

function replaceForkReferences(value: unknown, sourceId: string, forkId: string): unknown {
  if (Array.isArray(value))
    return value.map((item) => replaceForkReferences(item, sourceId, forkId))
  if (!value || typeof value !== 'object') return value
  const sourceDir = getSessionDir(sourceId)
  const forkDir = getSessionDir(forkId)
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'sessionId' && item === sourceId
        ? forkId
        : key === 'outputPreview' && typeof item === 'string'
          ? item.replaceAll(`${sourceDir}${sep}`, `${forkDir}${sep}`)
          : typeof item === 'string' &&
              (key === 'path' || key.endsWith('Path')) &&
              item.startsWith(`${sourceDir}/`)
            ? `${forkDir}${item.slice(sourceDir.length)}`
            : replaceForkReferences(item, sourceId, forkId)
    ])
  )
}

function referencedForkFiles(events: StoredSessionEvent[], sourceId: string): string[] {
  const sourceDir = getSessionDir(sourceId)
  const files = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith(`${sourceDir}${sep}`)) files.add(value)
      return
    }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const record = value as Record<string, unknown>
    if (
      record.sessionId === sourceId &&
      typeof record.id === 'string' &&
      /^[0-9a-f]{64}$/.test(record.id) &&
      typeof record.mimeType === 'string' &&
      Object.hasOwn(PROMPT_IMAGE_EXTENSIONS, record.mimeType)
    ) {
      const extension = PROMPT_IMAGE_EXTENSIONS[record.mimeType]
      files.add(join(sourceDir, ARTIFACTS_DIR, 'prompt-images', `${record.id}.${extension}`))
    }
    Object.values(record).forEach(visit)
  }
  events.forEach(visit)
  return [...files]
}

export function forkPhiSession(
  sourceId: string,
  eventId: string,
  runtime: string | { path: string; kernelRuntimeRef?: KernelRuntimeRef }
): PhiSessionRecord {
  const source = findPhiSessionById(sourceId)
  if (!source) throw new Error('来源会话不存在')
  const runtimeSessionPath = typeof runtime === 'string' ? runtime : runtime.path
  const kernelRuntimeRef = typeof runtime === 'string' ? undefined : runtime.kernelRuntimeRef
  // A kernel fork carries its own reference; the source itself is never opened locally here.
  assertLocalRuntimeAccess(source, kernelForkAccess(kernelRuntimeRef, source.kernelRuntimeRef))
  const events = readSessionEvents(sourceId)
  const selected = events.findIndex(
    (event) => event.eventId === eventId && event.type === 'user_message'
  )
  if (selected < 0) throw new Error('分叉消息不存在')
  const nextUser = events.findIndex(
    (event, index) => index > selected && event.type === 'user_message'
  )
  const included = events.slice(0, nextUser < 0 ? undefined : nextUser)
  const sourceDisplayTitle = sessionDisplayTitleFromManifest(source)
  const fork = createPhiSession({
    kind: source.kind,
    projectId: source.projectId,
    projectLocation: source.projectLocation,
    cwd: source.cwd,
    cwdRealPath: source.cwdRealPath,
    title: sourceDisplayTitle ? `${sourceDisplayTitle}（分叉）` : '分叉会话',
    ...(kernelRuntimeRef ? {} : { runtimeSessionPath }),
    remoteRuntime: source.remoteRuntime,
    permissionMode: source.permissionMode,
    workMode: source.workMode,
    model: source.model,
    thinkingLevel: source.thinkingLevel,
    autoCompaction: source.autoCompaction,
    forkedFrom: { sessionId: sourceId, eventId }
  })
  try {
    const sourceDir = getSessionDir(sourceId)
    const sourceRealDir = realpathSync(sourceDir)
    for (const path of referencedForkFiles(included, sourceId)) {
      const part = relative(sourceDir, path)
      if (part.startsWith('..') || isAbsolute(part)) continue
      if (
        !part.startsWith(`${TOOL_OUTPUTS_DIR}${sep}`) &&
        !part.startsWith(`${ARTIFACTS_DIR}${sep}`)
      )
        continue
      if (!existsSync(path) || !lstatSync(path).isFile()) continue
      const actualPart = relative(sourceRealDir, realpathSync(path))
      if (actualPart.startsWith('..') || isAbsolute(actualPart)) continue
      const destination = join(fork.dir, part)
      ensureDir(join(destination, '..'))
      copyFileSync(path, destination)
    }
    const ids = new Map(included.map((event) => [event.eventId, randomUUID()]))
    for (const event of included) {
      const copied = replaceForkReferences(event, sourceId, fork.sessionId) as StoredSessionEvent
      const stored = {
        ...copied,
        eventId: ids.get(event.eventId),
        sessionId: fork.sessionId,
        ...(typeof copied.userMessageId === 'string' && ids.has(copied.userMessageId)
          ? { userMessageId: ids.get(copied.userMessageId) }
          : {})
      }
      appendFileSync(getMessagesPath(fork.sessionId), `${JSON.stringify(stored)}\n`, 'utf-8')
    }
    let manifest = updateSessionManifest(fork.sessionId, {
      messageCount: included.length,
      lastEventType: included.at(-1)?.type
    })
    if (kernelRuntimeRef) {
      manifest = recordKernelRuntimeReference(fork.sessionId, kernelRuntimeRef)
    }
    return { ...fork, manifest }
  } catch (error) {
    deletePhiSession(fork.sessionId)
    throw error
  }
}

interface RestartedAgentExecution {
  toolCallId: string
  runId?: string
  agentName?: string
}

function openAgentExecutionsToClose(manifest: PhiSessionManifest): RestartedAgentExecution[] {
  if (manifest.openAgentExecutions !== undefined) {
    return manifest.openAgentExecutions
      .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string')
      .map((toolCallId) => ({ toolCallId }))
  }

  // Legacy manifests have no open set: derive it from history. The recovered manifest
  // records an empty set, so this scan runs at most once per session.
  const started = new Map<string, StoredSessionEvent>()
  const completed = new Set<string>()
  for (const event of readSessionEvents(manifest.sessionId)) {
    if (typeof event.toolCallId !== 'string') continue
    if (event.type === 'agent_execution_started') {
      started.set(event.toolCallId, event)
    } else if (event.type === 'agent_execution_completed') {
      completed.add(event.toolCallId)
    }
  }
  return [...started]
    .filter(([toolCallId]) => !completed.has(toolCallId))
    .map(([toolCallId, startedEvent]) => ({
      toolCallId,
      ...(typeof startedEvent.runId === 'string' ? { runId: startedEvent.runId } : {}),
      ...(typeof startedEvent.agentName === 'string' ? { agentName: startedEvent.agentName } : {})
    }))
}

// No agent run from a previous process survives a restart, even in an idle session.
// The closing events carry the session's last activity time, so a repaired old session keeps
// its place in the session list instead of jumping to the top.
function closeRestartedAgentExecutions(manifest: PhiSessionManifest): number {
  const open = openAgentExecutionsToClose(manifest)
  for (const execution of open) {
    appendSessionEvent(manifest.sessionId, {
      type: 'agent_execution_completed',
      createdAt: manifest.lastActivityAt,
      toolCallId: execution.toolCallId,
      ...(execution.runId ? { runId: execution.runId } : {}),
      ...(execution.agentName ? { agentName: execution.agentName } : {}),
      isError: true,
      cancelled: true,
      error: 'app_restarted'
    })
  }
  return open.length
}

/** Record the empty open set without touching updatedAt, so session ordering is unchanged. */
function markNoOpenAgentExecutions(sessionId: string): PhiSessionManifest {
  const current = readManifest(sessionId)
  const updated = { ...current, openAgentExecutions: [] }
  writeManifest(updated)
  return updated
}

function recoverPendingPlanReviews(sessionId: string): void {
  const pendingReviews = new Map<string, StoredSessionEvent>()
  for (const event of readSessionEvents(sessionId)) {
    if (event.type === 'plan_review_submitted' && typeof event.reviewId === 'string') {
      pendingReviews.set(event.reviewId, event)
    }
    if (event.type === 'plan_review_decided' && typeof event.reviewId === 'string') {
      pendingReviews.delete(event.reviewId)
    }
  }
  for (const [reviewId, event] of pendingReviews) {
    appendSessionEvent(sessionId, {
      type: 'plan_review_decided',
      reviewId,
      ...(event.runId ? { runId: event.runId } : {}),
      decision: 'cancel',
      reason: 'app_restarted'
    })
  }
}

function recoverInterruptedManifest(manifest: PhiSessionManifest): PhiSessionManifest {
  const wasActive =
    manifest.status === 'running' ||
    manifest.status === 'needs_approval' ||
    manifest.status === 'needs_input' ||
    manifest.currentRunId !== undefined ||
    manifest.currentRunStartedAt !== undefined

  const closed = closeRestartedAgentExecutions(manifest)
  if (!wasActive) {
    // Most sessions have nothing open: leave their files untouched on every startup.
    if (closed === 0 && manifest.openAgentExecutions?.length === 0) return manifest
    return markNoOpenAgentExecutions(manifest.sessionId)
  }

  recoverPendingPlanReviews(manifest.sessionId)
  appendSessionEvent(manifest.sessionId, {
    type: 'run_interrupted',
    ...(manifest.currentRunId ? { runId: manifest.currentRunId } : {}),
    reason: 'app_restarted'
  })
  return updateSessionManifest(manifest.sessionId, {
    status: 'idle',
    unreadKind: null,
    currentRunId: undefined,
    currentRunStartedAt: undefined,
    lastRunOutcome: 'interrupted',
    openAgentExecutions: []
  })
}

export function recoverInterruptedPhiSessions(): PhiSessionManifest[] {
  const sessionsDir = getPhiSessionsDir()
  if (!existsSync(sessionsDir)) return []

  return readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return recoverInterruptedManifest(readManifest(entry.name))
      } catch {
        return null
      }
    })
    .filter((manifest): manifest is PhiSessionManifest => manifest !== null)
}

export function listPhiSessions(): PhiSessionManifest[] {
  const sessionsDir = getPhiSessionsDir()
  if (!existsSync(sessionsDir)) return []

  return readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return readManifest(entry.name)
      } catch {
        return null
      }
    })
    .filter((manifest): manifest is PhiSessionManifest => manifest !== null)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
}

export function findPhiSessionByRuntimePath(
  runtimeSessionPath: string,
  cwd?: string
): PhiSessionManifest | null {
  return (
    listPhiSessions().find(
      (manifest) =>
        !manifest.runtimeRef &&
        !manifest.runtimeRecoveryError &&
        manifest.runtimeSessionPath === runtimeSessionPath &&
        (cwd === undefined || manifest.cwd === cwd)
    ) ?? null
  )
}

export function findPhiSessionById(sessionId: string): PhiSessionManifest | null {
  try {
    return readManifest(sessionId)
  } catch {
    return null
  }
}

export function deletePhiSession(sessionId: string): void {
  assertSafeSessionId(sessionId)
  rmSync(getSessionDir(sessionId), { recursive: true, force: true })
}
