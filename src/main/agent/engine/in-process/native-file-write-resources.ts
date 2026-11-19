import type { BigIntStats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import type { AgentSession } from '@oh-my-pi/pi-coding-agent'
import type { ExecutionResource } from '../../resource-admission'
import { createResourceScheduler } from '../../resource-scheduler'

const namespace = 'local-file-write'
const maxIdentityChecks = 3
const claim = (segments: readonly string[]): ExecutionResource => ({
  namespace,
  segments,
  access: 'exclusive'
})
const unknownClaims = [claim([])]

export type FileWriteAdmission = <T>(
  absolutePath: string,
  signal: AbortSignal | undefined,
  runWrite: () => Promise<T>,
  onWait?: (waiting: boolean) => void
) => Promise<T>

interface FileIdentity {
  path: string
  inode?: string
}

function isAmbiguousPath(path: string): boolean {
  // Bun's realpath can collapse ".." before following a symlink, while its
  // writer follows the symlink first. The common claim covers either result.
  return !isAbsolute(path) || path.split(/[\\/]/).includes('..')
}

function canAppendMissingName(name: string): boolean {
  const hasWindowsAlias = process.platform === 'win32' && (/[. ]$/.test(name) || name.includes(':'))
  return /^[\x20-\x7e]+$/.test(name) && name !== '.' && !hasWindowsAlias
}

async function findEntry(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function fileIdentity(
  canonicalPath: string,
  entry: BigIntStats,
  missingSuffix: readonly string[]
): FileIdentity | undefined {
  if (missingSuffix.length && !entry.isDirectory()) return undefined
  return {
    // Fold case conservatively on all volumes.
    path: join(canonicalPath, ...missingSuffix)
      .normalize('NFC')
      .toLowerCase(),
    inode: entry.isFile() && entry.ino > 0n ? `${entry.dev}:${entry.ino}` : undefined
  }
}

async function observeFile(
  absolutePath: string,
  signal: AbortSignal | undefined
): Promise<FileIdentity | undefined> {
  if (isAmbiguousPath(absolutePath)) return undefined
  let current = absolutePath
  const missing: string[] = []

  try {
    signal?.throwIfAborted()
    let entry = await findEntry(current)
    while (!entry) {
      signal?.throwIfAborted()
      const name = basename(current)
      const parent = dirname(current)
      if (parent === current || !canAppendMissingName(name)) return undefined
      missing.push(name)
      current = parent
      entry = await findEntry(current)
    }

    const canonical = await realpath(current)
    const target = entry.isSymbolicLink() ? await lstat(canonical, { bigint: true }) : entry
    signal?.throwIfAborted()
    return fileIdentity(canonical, target, missing.reverse())
  } catch {
    signal?.throwIfAborted()
    // Dangling links, inaccessible ancestors and ambiguous paths share one claim.
    return undefined
  }
}

export function createFileWriteAdmission(): FileWriteAdmission {
  const scheduler = createResourceScheduler()

  return async (absolutePath, signal, runWrite, onWait) => {
    let waiting = false
    let identity = await observeFile(absolutePath, signal)

    const report = (value: boolean): void => {
      if (waiting === value) return
      waiting = value
      try {
        onWait?.(waiting)
      } catch {
        // A progress listener cannot cancel the write or strand its lease.
      }
    }

    for (let attempt = 0; ; attempt++) {
      if (attempt >= maxIdentityChecks) identity = undefined
      const expected = identity
      const claims = expected
        ? [claim(['path', ...expected.path.split(sep).filter(Boolean)])]
        : unknownClaims
      if (expected?.inode) claims.push(claim(['inode', expected.inode]))
      const outcome = await scheduler.run(
        claims,
        signal,
        async () => {
          if (expected) {
            const current = await observeFile(absolutePath, signal)
            if (current?.path !== expected.path || current?.inode !== expected.inode) {
              return { kind: 'retry' as const, identity: current }
            }
          }
          report(false)
          signal?.throwIfAborted()
          return { kind: 'written' as const, value: await runWrite() }
        },
        () => report(true)
      )
      if (outcome.kind === 'written') return outcome.value
      // Let the scheduler release the stale claim before queueing another one.
      identity = outcome.identity
    }
  }
}

const admitFileWrite = createFileWriteAdmission()

/** The pinned SDK joins the real writer inside its own abort-raced tool call. */
export function installNativeFileWriteResources(
  session: Pick<AgentSession, 'getToolByName'>
): void {
  const write = session.getToolByName('write') as
    { setPhiFileWriteAdmission?: (admit: FileWriteAdmission) => void } | undefined
  const edit = session.getToolByName('edit') as
    { separatePhiFileWritesFromEditBatches?: () => void } | undefined
  if (typeof write?.setPhiFileWriteAdmission !== 'function') return
  write.setPhiFileWriteAdmission(admitFileWrite)
  if (typeof edit?.separatePhiFileWritesFromEditBatches === 'function') {
    edit.separatePhiFileWritesFromEditBatches()
  }
}
