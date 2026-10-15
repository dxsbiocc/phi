import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import { getPhiAgentDir } from '../runtime-paths'
import {
  parseRuntimeReference,
  remoteOmpJournalPath,
  type RemoteOmpRuntimeRef
} from './runtime-reference'
import { readRecoveryFile, recoveryFile, writeRecoveryFile } from './private-recovery-file'

export interface ChildRunRecoverySnapshot {
  readonly id: string
  readonly phiSessionId: string
  readonly projectId: string
  readonly generation: number
  readonly parentRunId: string
  readonly parentToolCallId: string
  readonly nativeId: string
  readonly childSessionFile: string
  readonly agent: string
  readonly background: boolean
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'
  readonly verified: boolean
  readonly startedAt: number
  readonly completedAt?: number
  readonly childOmpSessionId?: string
}
interface RecordOnDisk {
  readonly schemaVersion: 1
  readonly reference: RemoteOmpRuntimeRef
  readonly snapshot: ChildRunRecoverySnapshot
}
const keys = [
  'id',
  'phiSessionId',
  'projectId',
  'generation',
  'parentRunId',
  'parentToolCallId',
  'nativeId',
  'childSessionFile',
  'agent',
  'background',
  'status',
  'verified',
  'startedAt'
]
// Match the existing RPC approval/lifecycle opaque identifier contract, not filesystem names.
const id = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !Array.from(value).some(
    (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
  )
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
const time = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0
const terminal = (status: string): boolean =>
  ['completed', 'failed', 'aborted', 'interrupted'].includes(status)
function parse(value: unknown, phiSessionId: string): RecordOnDisk {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'reference,schemaVersion,snapshot' ||
    value.schemaVersion !== 1 ||
    !object(value.snapshot)
  )
    throw new Error('Invalid child recovery record')
  const reference = parseRuntimeReference(value.reference, phiSessionId)
  const run = value.snapshot
  if (
    keys.some((key) => !Object.hasOwn(run, key)) ||
    Object.keys(run).some(
      (key) => !keys.includes(key) && !['completedAt', 'childOmpSessionId'].includes(key)
    ) ||
    ![
      'id',
      'phiSessionId',
      'projectId',
      'parentRunId',
      'parentToolCallId',
      'nativeId',
      'agent'
    ].every((key) => id(run[key])) ||
    run.phiSessionId !== phiSessionId ||
    run.projectId !== reference.projectId ||
    !Number.isSafeInteger(run.generation) ||
    Number(run.generation) < 1 ||
    typeof run.background !== 'boolean' ||
    typeof run.verified !== 'boolean' ||
    !['queued', 'running', 'completed', 'failed', 'aborted', 'interrupted'].includes(
      String(run.status)
    ) ||
    !time(run.startedAt) ||
    (run.completedAt !== undefined && !time(run.completedAt)) ||
    (run.childOmpSessionId !== undefined && !id(run.childOmpSessionId)) ||
    typeof run.childSessionFile !== 'string'
  )
    throw new Error('Invalid child recovery snapshot')
  const root = remoteOmpJournalPath(reference)
  if (run.childSessionFile !== '') {
    if (
      run.childSessionFile.length > 4096 ||
      Array.from(run.childSessionFile).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      posix.normalize(run.childSessionFile) !== run.childSessionFile ||
      posix.dirname(run.childSessionFile) !== root.slice(0, -6) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.jsonl$/.test(posix.basename(run.childSessionFile)) ||
      posix.basename(run.childSessionFile).includes('..')
    )
      throw new Error('Child recovery journal is outside the owned root')
  } else if (run.verified) throw new Error('Verified child recovery journal is missing')
  return {
    schemaVersion: 1,
    reference,
    snapshot: Object.freeze({ ...run }) as unknown as ChildRunRecoverySnapshot
  }
}
function pathParts(phiSessionId: string, childRunId: string): readonly string[] {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(phiSessionId) || !id(childRunId))
    throw new Error('Invalid child recovery identity')
  return [
    'sessions',
    phiSessionId,
    'rpc-child-runs',
    createHash('sha256').update(childRunId).digest('hex') + '.json'
  ]
}
function sameRoot(a: RemoteOmpRuntimeRef, b: RemoteOmpRuntimeRef): boolean {
  return [
    'durableSessionKey',
    'ompSessionId',
    'journalBasename',
    'hostProfileId',
    'bindingHash',
    'projectId',
    'projectRoot',
    'runtimeRoot'
  ].every((key) => a[key as keyof RemoteOmpRuntimeRef] === b[key as keyof RemoteOmpRuntimeRef])
}

/** Only a verified main-owned lifecycle sink may call this. No SDK handle/capability is persisted. */
export function recordChildRunRecovery(
  input: { reference: RemoteOmpRuntimeRef; snapshot: ChildRunRecoverySnapshot },
  options: { assertCurrent?(): void } = {},
  agentDir = getPhiAgentDir()
): void {
  const record = parse({ schemaVersion: 1, ...input }, input.snapshot.phiSessionId)
  options.assertCurrent?.()
  const path = recoveryFile(
    agentDir,
    pathParts(record.snapshot.phiSessionId, record.snapshot.id),
    true
  )
  try {
    const previous = parse(readRecoveryFile(path), record.snapshot.phiSessionId)
    if (
      !sameRoot(previous.reference, record.reference) ||
      [
        'id',
        'phiSessionId',
        'projectId',
        'generation',
        'parentRunId',
        'parentToolCallId',
        'nativeId',
        'agent',
        'background',
        'startedAt'
      ].some(
        (key) =>
          previous.snapshot[key as keyof ChildRunRecoverySnapshot] !==
          record.snapshot[key as keyof ChildRunRecoverySnapshot]
      ) ||
      (previous.snapshot.childSessionFile &&
        previous.snapshot.childSessionFile !== record.snapshot.childSessionFile) ||
      (previous.snapshot.childOmpSessionId &&
        previous.snapshot.childOmpSessionId !== record.snapshot.childOmpSessionId)
    )
      throw new Error('Child recovery identity cannot be retargeted')
    if (terminal(previous.snapshot.status)) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  options.assertCurrent?.()
  writeRecoveryFile(path, record)
}

/** Cold metadata only. Old files are remote locators; this function performs no IO on them. */
export function readColdChildRuns(
  input: { phiSessionId: string; reference: RemoteOmpRuntimeRef },
  agentDir = getPhiAgentDir()
): readonly (ChildRunRecoverySnapshot & {
  readonly canControl: false
  readonly historyAvailable: false
})[] {
  const reference = parseRuntimeReference(input.reference, input.phiSessionId)
  let directory: string
  try {
    directory = dirname(recoveryFile(agentDir, pathParts(input.phiSessionId, 'probe'), false))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return readdirSync(directory)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .sort()
    .map((name) => {
      const record = parse(
        readRecoveryFile(
          recoveryFile(agentDir, ['sessions', input.phiSessionId, 'rpc-child-runs', name], false)
        ),
        input.phiSessionId
      )
      if (
        !sameRoot(record.reference, reference) ||
        name !== createHash('sha256').update(record.snapshot.id).digest('hex') + '.json'
      )
        throw new Error('Child recovery binding changed')
      return Object.freeze({
        ...record.snapshot,
        status: terminal(record.snapshot.status)
          ? record.snapshot.status
          : ('interrupted' as const),
        canControl: false as const,
        historyAvailable: false as const
      })
    })
}
