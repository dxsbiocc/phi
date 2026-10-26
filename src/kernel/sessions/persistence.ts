import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

import { MAX_CLIENT_RUN_KEY_LENGTH, type RunCompletedPayload } from '../../shared/kernel-protocol'
import { SESSION_MANIFEST_SCHEMA_VERSION, type RunReceipt, type SessionManifest } from './types'

const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_RECEIPT_BYTES = 16 * 1024
const JOURNAL_PREFIX_BYTES = 16 * 1024
const terminalStatuses = new Set<RunCompletedPayload['status']>([
  'completed',
  'failed',
  'cancelled',
  'unknown'
])
const thinkingLevels = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const workModes = new Set(['direct', 'plan', 'plan_execute', 'auto'])

function fsCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0)
}

function validPersistedSessionPolicy(policy: Record<string, unknown>): boolean {
  const allowed = new Set(['noTools', 'workMode', 'enableToolApproval', 'autoCompaction'])
  return (
    !Object.keys(policy).some((key) => !allowed.has(key)) &&
    Object.hasOwn(policy, 'noTools') &&
    Object.hasOwn(policy, 'workMode') &&
    Object.hasOwn(policy, 'enableToolApproval') &&
    (policy.noTools === 'all' || typeof policy.noTools === 'boolean') &&
    typeof policy.workMode === 'string' &&
    workModes.has(policy.workMode) &&
    typeof policy.enableToolApproval === 'boolean'
  )
}

function persistedAutoCompaction(value: unknown): { enabled: boolean } | undefined {
  if (value === undefined) return undefined
  const policy = record(value)
  if (
    !policy ||
    Object.keys(policy).join(',') !== 'enabled' ||
    typeof policy.enabled !== 'boolean'
  ) {
    throw new Error('session manifest persisted auto-compaction policy is invalid')
  }
  return { enabled: policy.enabled }
}

function persistedSessionPolicy(
  value: unknown
): NonNullable<SessionManifest['policy']>['sessionPolicy'] {
  const policy = record(value)
  if (!policy || !validPersistedSessionPolicy(policy)) {
    throw new Error('session manifest persisted policy is invalid')
  }
  const autoCompaction = persistedAutoCompaction(policy.autoCompaction)
  return {
    noTools: policy.noTools as 'all' | boolean,
    workMode: policy.workMode as 'direct' | 'plan' | 'plan_execute' | 'auto',
    enableToolApproval: policy.enableToolApproval as boolean,
    ...(autoCompaction ? { autoCompaction } : {})
  }
}

function sessionPolicy(
  value: unknown,
  schemaVersion: 1 | typeof SESSION_MANIFEST_SCHEMA_VERSION
): SessionManifest['policy'] | undefined {
  if (value === undefined) return undefined
  const policy = record(value)
  const keys = Object.keys(policy ?? {})
    .sort()
    .join(',')
  const expectedKeys =
    schemaVersion === 1
      ? 'projectBound,requiresTrustedResources'
      : keys === 'projectBound,requiresTrustedResources'
        ? keys
        : 'projectBound,requiresTrustedResources,sessionPolicy'
  if (
    !policy ||
    keys !== expectedKeys ||
    typeof policy.projectBound !== 'boolean' ||
    typeof policy.requiresTrustedResources !== 'boolean' ||
    (schemaVersion === 1 && policy.sessionPolicy !== undefined)
  ) {
    throw new Error('session manifest policy is invalid')
  }
  const plain =
    schemaVersion === SESSION_MANIFEST_SCHEMA_VERSION && policy.sessionPolicy !== undefined
      ? persistedSessionPolicy(policy.sessionPolicy)
      : undefined
  return {
    projectBound: policy.projectBound,
    requiresTrustedResources: policy.requiresTrustedResources,
    ...(plain ? { sessionPolicy: plain } : {})
  }
}

function sessionLastRun(value: unknown): SessionManifest['lastRun'] | undefined {
  if (value === undefined) return undefined
  const lastRun = record(value)
  if (
    !lastRun ||
    Object.keys(lastRun).sort().join(',') !== 'runId,status' ||
    typeof lastRun.runId !== 'string' ||
    !lastRun.runId ||
    !terminalStatuses.has(lastRun.status as RunCompletedPayload['status'])
  ) {
    throw new Error('session manifest lastRun is invalid')
  }
  return {
    runId: lastRun.runId,
    status: lastRun.status as RunCompletedPayload['status']
  }
}

export function validateSessionManifest(
  candidate: unknown,
  expectedSessionId: string
): SessionManifest {
  const value = record(candidate)
  if (!value) throw new Error('session manifest is not an object')
  const schemaVersion = value.schemaVersion
  if (schemaVersion !== 1 && schemaVersion !== SESSION_MANIFEST_SCHEMA_VERSION) {
    throw new Error('session manifest fields are invalid')
  }
  const allowed = new Set([
    'schemaVersion',
    'sessionId',
    'cwd',
    'createdAt',
    'updatedAt',
    'model',
    'thinkingLevel',
    'title',
    'policy',
    'journal',
    'lastRun'
  ])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('session manifest has unknown fields')
  }
  if (
    value.sessionId !== expectedSessionId ||
    typeof value.cwd !== 'string' ||
    !isAbsolute(value.cwd) ||
    !validIso(value.createdAt) ||
    !validIso(value.updatedAt) ||
    value.journal !== 'journal.jsonl' ||
    !optionalString(value.title) ||
    (value.thinkingLevel !== undefined &&
      (typeof value.thinkingLevel !== 'string' || !thinkingLevels.has(value.thinkingLevel)))
  ) {
    throw new Error('session manifest fields are invalid')
  }
  const model = value.model === undefined ? undefined : record(value.model)
  if (
    model &&
    (Object.keys(model).sort().join(',') !== 'id,provider' ||
      typeof model.provider !== 'string' ||
      !model.provider ||
      typeof model.id !== 'string' ||
      !model.id)
  ) {
    throw new Error('session manifest model is invalid')
  }
  const lastRun = sessionLastRun(value.lastRun)
  const policy = sessionPolicy(value.policy, schemaVersion)
  return {
    schemaVersion: SESSION_MANIFEST_SCHEMA_VERSION,
    sessionId: expectedSessionId,
    cwd: value.cwd,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(model ? { model: { provider: model.provider as string, id: model.id as string } } : {}),
    ...(typeof value.thinkingLevel === 'string' ? { thinkingLevel: value.thinkingLevel } : {}),
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(policy ? { policy: structuredClone(policy) } : {}),
    journal: 'journal.jsonl',
    ...(lastRun ? { lastRun } : {})
  }
}

export async function writeManifestAtomic(path: string, manifest: SessionManifest): Promise<void> {
  const temporary = `${path}.tmp.${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  let published = false
  try {
    await handle.writeFile(`${JSON.stringify(manifest)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, path)
    await chmod(path, 0o600)
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
    published = true
  } finally {
    await handle.close().catch(() => undefined)
    if (!published) await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function readManifest(
  path: string,
  expectedSessionId: string
): Promise<SessionManifest> {
  const content = await readFile(path, 'utf8')
  if (Buffer.byteLength(content) > MAX_MANIFEST_BYTES) {
    throw new Error('session manifest exceeds its size limit')
  }
  try {
    return validateSessionManifest(JSON.parse(content), expectedSessionId)
  } catch (error) {
    throw new Error('session manifest is corrupt', { cause: error })
  }
}

function parseReceipt(value: unknown): RunReceipt | undefined {
  const receipt = record(value)
  if (!receipt || typeof receipt.runId !== 'string' || !receipt.runId || !validIso(receipt.at)) {
    return undefined
  }
  if (receipt.state === 'accepted') {
    if (
      Object.keys(receipt).some((key) => !['runId', 'clientRunKey', 'state', 'at'].includes(key)) ||
      (receipt.clientRunKey !== undefined &&
        (typeof receipt.clientRunKey !== 'string' ||
          !receipt.clientRunKey ||
          receipt.clientRunKey.length > MAX_CLIENT_RUN_KEY_LENGTH))
    ) {
      return undefined
    }
    return {
      runId: receipt.runId,
      ...(typeof receipt.clientRunKey === 'string' ? { clientRunKey: receipt.clientRunKey } : {}),
      state: 'accepted',
      at: receipt.at
    }
  }
  if (
    receipt.state !== 'terminal' ||
    Object.keys(receipt).some(
      (key) => !['runId', 'state', 'status', 'at', 'reason'].includes(key)
    ) ||
    !terminalStatuses.has(receipt.status as RunCompletedPayload['status']) ||
    (receipt.reason !== undefined && typeof receipt.reason !== 'string')
  ) {
    return undefined
  }
  return {
    runId: receipt.runId,
    state: 'terminal',
    status: receipt.status as RunCompletedPayload['status'],
    at: receipt.at,
    ...(typeof receipt.reason === 'string' ? { reason: receipt.reason } : {})
  }
}

export async function readReceipts(path: string): Promise<RunReceipt[]> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (fsCode(error) === 'ENOENT') return []
    throw error
  }
  const completeTail = content.endsWith('\n')
  const lines = content.split('\n')
  if (completeTail) lines.pop()
  const receipts: RunReceipt[] = []
  for (const [index, line] of lines.entries()) {
    if (!line) continue
    let parsed: RunReceipt | undefined
    try {
      parsed = parseReceipt(JSON.parse(line))
    } catch {
      parsed = undefined
    }
    if (!parsed && !completeTail && index === lines.length - 1) continue
    if (!parsed) throw new Error(`run receipt ${index + 1} is corrupt`)
    if (Buffer.byteLength(line) > MAX_RECEIPT_BYTES) {
      throw new Error(`run receipt ${index + 1} exceeds its size limit`)
    }
    receipts.push(parsed)
  }
  return receipts
}

export async function appendReceipt(path: string, receipt: RunReceipt): Promise<void> {
  const content = `${JSON.stringify(receipt)}\n`
  if (Buffer.byteLength(content) > MAX_RECEIPT_BYTES) {
    throw new Error('run receipt exceeds its size limit')
  }
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(path, 0o600)
}

/** Remove only an unterminated crash fragment while the caller owns writer.lock. */
export async function repairReceiptTail(path: string): Promise<void> {
  let content: Buffer
  try {
    content = await readFile(path)
  } catch (error) {
    if (fsCode(error) === 'ENOENT') return
    throw error
  }
  if (content.length === 0 || content[content.length - 1] === 0x0a) return
  const lastNewline = content.lastIndexOf(0x0a)
  const handle = await open(path, 'r+')
  try {
    await handle.truncate(lastNewline + 1)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function latestTerminal(
  receipts: readonly RunReceipt[]
): (RunReceipt & { state: 'terminal' }) | undefined {
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index]
    if (receipt?.state === 'terminal') return receipt
  }
  return undefined
}

function laterIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right
}

export function reconcileManifestReceipts(
  manifest: SessionManifest,
  receipts: readonly RunReceipt[]
): SessionManifest {
  const terminal = latestTerminal(receipts)
  if (!terminal) return manifest
  const lastRun = { runId: terminal.runId, status: terminal.status }
  if (
    manifest.lastRun?.runId === lastRun.runId &&
    manifest.lastRun.status === lastRun.status &&
    Date.parse(manifest.updatedAt) >= Date.parse(terminal.at)
  ) {
    return manifest
  }
  return {
    ...manifest,
    updatedAt: laterIso(manifest.updatedAt, terminal.at),
    lastRun
  }
}

export async function reconstructManifest(options: {
  sessionId: string
  journalPath: string
  receipts: readonly RunReceipt[]
}): Promise<SessionManifest> {
  const handle = await open(options.journalPath, 'r')
  let prefix = ''
  try {
    const buffer = Buffer.alloc(JOURNAL_PREFIX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    prefix = buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
  let header: Record<string, unknown> | undefined
  let title: string | undefined
  for (const line of prefix.split('\n')) {
    if (!line.trim()) continue
    let value: Record<string, unknown> | undefined
    try {
      value = record(JSON.parse(line))
    } catch {
      continue
    }
    if (value?.type === 'session_title' && typeof value.title === 'string' && value.title) {
      title = value.title
    }
    if (value?.type === 'session') {
      header = value
      break
    }
  }
  if (
    !header ||
    typeof header.cwd !== 'string' ||
    !isAbsolute(header.cwd) ||
    !validIso(header.timestamp)
  ) {
    throw new Error('journal header cannot repair the session manifest')
  }
  const journalStat = await stat(options.journalPath)
  const createdAt = header.timestamp
  const manifest: SessionManifest = {
    schemaVersion: SESSION_MANIFEST_SCHEMA_VERSION,
    sessionId: options.sessionId,
    cwd: header.cwd,
    createdAt,
    updatedAt: laterIso(createdAt, journalStat.mtime.toISOString()),
    ...(title ? { title } : {}),
    // The OMP journal cannot prove the former project/resource policy. Repair must
    // fail closed so manifest corruption never removes project path guards.
    policy: { projectBound: true, requiresTrustedResources: true },
    journal: 'journal.jsonl'
  }
  return reconcileManifestReceipts(manifest, options.receipts)
}

export async function ensurePrivateDirectory(path: string, recursive = false): Promise<void> {
  await mkdir(path, { recursive, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Kernel session path is not a private directory')
  }
  await chmod(path, 0o700)
}
