import type { BigIntStats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import type { AgentSession } from '@oh-my-pi/pi-coding-agent'
import type { ExecutionResource } from '../../resource-admission'
import { createResourceScheduler } from '../../resource-scheduler'

const namespace = 'local-file-write'
const maxIdentityChecks = 3
const maxBatchFiles = 32
const claim = (segments: readonly string[]): ExecutionResource => ({
  namespace,
  segments,
  access: 'exclusive'
})
const unknownClaims = [claim([])]

type FileWriteTarget = string | { path: string; mustExist: true }

export type FileWriteAdmission = <T>(
  paths: string | readonly FileWriteTarget[],
  signal: AbortSignal | undefined,
  runWrite: (usesCommonClaim: boolean) => Promise<T>,
  onWait?: (waiting: boolean) => void
) => Promise<T>

interface FileIdentity {
  path: string
  linkPath?: string
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
    const identity = fileIdentity(canonical, target, missing.reverse())
    if (identity && entry.isSymbolicLink() && missing.length === 0) {
      // A delete or move can unlink the leaf itself while another tool follows it.
      identity.linkPath = join(await realpath(dirname(current)), basename(current))
        .normalize('NFC')
        .toLowerCase()
    }
    signal?.throwIfAborted()
    return identity
  } catch {
    signal?.throwIfAborted()
    // Dangling links, inaccessible ancestors and ambiguous paths share one claim.
    return undefined
  }
}

async function observeBatch(
  targets: readonly FileWriteTarget[],
  signal: AbortSignal | undefined
): Promise<FileIdentity[] | undefined> {
  if (targets.length === 0) return undefined
  const identities: FileIdentity[] = []
  for (const target of targets) {
    signal?.throwIfAborted()
    const path = typeof target === 'string' ? target : target.path
    const identity = await observeFile(path, signal)
    if (!identity) return undefined
    // An absent edit source may be rebound by the native editor to another file.
    if (typeof target !== 'string' && target.mustExist && !identity.inode) return undefined
    identities.push(identity)
  }
  return identities
}

function claimsForBatch(identities: readonly FileIdentity[]): ExecutionResource[] {
  const paths = new Set<string>()
  const inodes = new Set<string>()
  for (const { path, linkPath, inode } of identities) {
    paths.add(path)
    if (linkPath) paths.add(linkPath)
    if (inode) inodes.add(inode)
  }
  return [
    ...Array.from(paths, (path) => claim(['path', ...path.split(sep).filter(Boolean)])),
    ...Array.from(inodes, (inode) => claim(['inode', inode]))
  ]
}

function sameBatch(before: readonly FileIdentity[], after: readonly FileIdentity[]): boolean {
  return before.every((identity, index) => {
    const current = after[index]
    return (
      identity.path === current.path &&
      identity.linkPath === current.linkPath &&
      identity.inode === current.inode
    )
  })
}

function snapshotTargets(paths: string | readonly FileWriteTarget[]): FileWriteTarget[] {
  if (typeof paths === 'string') return [paths]
  if (paths.length > maxBatchFiles) return []
  const targets = new Map<string, FileWriteTarget>()
  for (const target of paths) {
    if (typeof target === 'string') {
      if (!targets.has(target)) targets.set(target, target)
    } else {
      targets.set(target.path, { ...target })
    }
  }
  return [...targets.values()]
}

export function createFileWriteAdmission(): FileWriteAdmission {
  const scheduler = createResourceScheduler()

  return async (paths, signal, runWrite, onWait) => {
    signal?.throwIfAborted()
    const targets = snapshotTargets(paths)
    let waiting = false
    let identities = await observeBatch(targets, signal)

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
      const expected = attempt < maxIdentityChecks ? identities : undefined
      const claims = expected ? claimsForBatch(expected) : unknownClaims
      const outcome = await scheduler.run(
        claims,
        signal,
        async () => {
          if (expected) {
            const current = await observeBatch(targets, signal)
            if (!current || !sameBatch(expected, current)) {
              return { kind: 'retry' as const, identity: current }
            }
          }
          report(false)
          signal?.throwIfAborted()
          return { kind: 'written' as const, value: await runWrite(!expected) }
        },
        () => report(true)
      )
      if (outcome.kind === 'written') return outcome.value
      // Let the scheduler release the stale claim before queueing another one.
      identities = outcome.identity
    }
  }
}

const admitFileWrite = createFileWriteAdmission()

/** The pinned SDK joins the real writer inside its own abort-raced tool call. */
export function installNativeFileWriteResources(
  session: Pick<AgentSession, 'getToolByName'>
): void {
  for (const name of ['write', 'edit', 'ast_edit']) {
    const tool = session.getToolByName(name) as
      { setPhiFileWriteAdmission?: (admit: FileWriteAdmission) => void } | undefined
    if (typeof tool?.setPhiFileWriteAdmission === 'function') {
      tool.setPhiFileWriteAdmission(admitFileWrite)
    }
  }
}
