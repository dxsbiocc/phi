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
import { getPhiAgentDir } from '../runtime-paths'

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
  forkedFrom?: { sessionId: string; eventId: string }
  runtimeSessionPath?: string
  permissionMode: PermissionMode
  model?: ModelSelection
  thinkingLevel?: ThinkingLevel
  autoCompaction?: AutoCompactionOverrides
  status: SessionStatus
  unreadKind: UnreadKind | null
  currentRunId?: string
  lastRunOutcome?: LastRunOutcome
  lastEventType?: string
  messageCount: number
  currentRunStartedAt?: string
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
  permissionMode: PermissionMode
  model?: ModelSelection
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
  return JSON.parse(readFileSync(manifestPath, 'utf-8')) as PhiSessionManifest
}

function writeManifest(manifest: PhiSessionManifest): void {
  const dir = getSessionDir(manifest.sessionId)
  ensureDir(dir)
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
}

function withoutUndefinedOptionalFields(manifest: PhiSessionManifest): PhiSessionManifest {
  const next = { ...manifest }
  if (next.title === undefined) delete next.title
  if (next.forkedFrom === undefined) delete next.forkedFrom
  if (next.projectLocation === undefined) delete next.projectLocation
  if (next.runtimeSessionPath === undefined) delete next.runtimeSessionPath
  if (next.model === undefined) delete next.model
  if (next.thinkingLevel === undefined) delete next.thinkingLevel
  if (next.autoCompaction === undefined) delete next.autoCompaction
  if (next.currentRunId === undefined) delete next.currentRunId
  if (next.currentRunStartedAt === undefined) delete next.currentRunStartedAt
  if (next.lastRunOutcome === undefined) delete next.lastRunOutcome
  if (next.lastEventType === undefined) delete next.lastEventType
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
    permissionMode: input.permissionMode,
    ...(input.model ? { model: input.model } : {}),
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
  patch: Partial<Omit<PhiSessionManifest, 'schemaVersion' | 'sessionId' | 'createdAt'>>
): PhiSessionManifest {
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

  appendFileSync(getMessagesPath(sessionId), `${JSON.stringify(stored)}\n`, 'utf-8')
  writeManifest({
    ...manifest,
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
  runtimeSessionPath: string
): PhiSessionRecord {
  const source = findPhiSessionById(sourceId)
  if (!source) throw new Error('来源会话不存在')
  const events = readSessionEvents(sourceId)
  const selected = events.findIndex(
    (event) => event.eventId === eventId && event.type === 'user_message'
  )
  if (selected < 0) throw new Error('分叉消息不存在')
  const nextUser = events.findIndex(
    (event, index) => index > selected && event.type === 'user_message'
  )
  const included = events.slice(0, nextUser < 0 ? undefined : nextUser)
  const fork = createPhiSession({
    kind: source.kind,
    projectId: source.projectId,
    projectLocation: source.projectLocation,
    cwd: source.cwd,
    cwdRealPath: source.cwdRealPath,
    title: source.title ? `${source.title}（分叉）` : '分叉会话',
    runtimeSessionPath,
    permissionMode: source.permissionMode,
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
    const manifest = updateSessionManifest(fork.sessionId, {
      messageCount: included.length,
      lastEventType: included.at(-1)?.type
    })
    return { ...fork, manifest }
  } catch (error) {
    deletePhiSession(fork.sessionId)
    throw error
  }
}

function recoverInterruptedManifest(manifest: PhiSessionManifest): PhiSessionManifest {
  const wasActive =
    manifest.status === 'running' ||
    manifest.status === 'needs_approval' ||
    manifest.status === 'needs_input' ||
    manifest.currentRunId !== undefined ||
    manifest.currentRunStartedAt !== undefined
  if (!wasActive) return manifest

  const pendingReviews = new Map<string, StoredSessionEvent>()
  for (const event of readSessionEvents(manifest.sessionId)) {
    if (event.type === 'plan_review_submitted' && typeof event.reviewId === 'string') {
      pendingReviews.set(event.reviewId, event)
    }
    if (event.type === 'plan_review_decided' && typeof event.reviewId === 'string') {
      pendingReviews.delete(event.reviewId)
    }
  }
  for (const [reviewId, event] of pendingReviews) {
    appendSessionEvent(manifest.sessionId, {
      type: 'plan_review_decided',
      reviewId,
      ...(event.runId ? { runId: event.runId } : {}),
      decision: 'cancel',
      reason: 'app_restarted'
    })
  }

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
    lastRunOutcome: 'interrupted'
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
