import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { posix } from 'node:path'
import { createEmptyLibraryIndex, libraryNoteMarkdown } from '../../library/library-store'
import type { LibraryIndex } from '../../library/library-types'
import { acquireOwnedRemoteLock } from './extension-deployment/remote-lock'
import { libraryCommand } from './remote-library-commands'
import {
  REMOTE_LIBRARY_MAX_INDEX_BYTES,
  RemoteLibraryError,
  type RemoteLibraryTarget
} from './remote-library-types'
import {
  paperProjection,
  validLibraryStorageKey,
  validateRemoteLibraryIndex
} from './remote-library-validation'

interface Snapshot {
  index: LibraryIndex
  hash?: string
  pending?: string
  exists: boolean
}
interface Change<T> {
  index: LibraryIndex
  result: T
  key?: string
}
const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex')
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new RemoteLibraryError('FILE_INVALID', 'Remote literature library JSON is malformed')
  }
}

/** The index is authoritative; pending only records which derived projection needs repair. */
export class RemoteLibraryStorage {
  private readonly root: string
  private readonly directory: string
  constructor(private readonly target: RemoteLibraryTarget) {
    this.root = target.workspace.projectRoot
    if (
      !this.root.startsWith('/') ||
      this.root === '/' ||
      posix.normalize(this.root) !== this.root ||
      /[\0\r\n]/.test(this.root)
    )
      throw new RemoteLibraryError(
        'PATH_INVALID',
        'Remote library requires its selected canonical project root'
      )
    this.directory = posix.join(this.root, '.phi/library')
  }
  async read(signal?: AbortSignal): Promise<LibraryIndex> {
    const snapshot = await this.snapshot('read', signal)
    if (!snapshot.pending) return snapshot.index
    return this.locked(async (assertOwned) => {
      const current = await this.snapshot('read', signal)
      await this.recover(current, assertOwned)
      return current.index
    }, signal)
  }
  async mutate<T>(transform: (index: LibraryIndex) => Change<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const initial = await this.snapshot('read', signal)
    if (!initial.exists) {
      // The pure preview preserves no-data behavior for missing/invalid operations.
      // Concurrent saves are recomputed against the authoritative index under lock.
      const preview = transform(initial.index)
      validateRemoteLibraryIndex(preview.index)
      if (!preview.key) return preview.result
    }
    await this.snapshot('prepare', signal)
    return this.locked(async (assertOwned) => {
      const before = await this.snapshot('prepare', signal)
      await this.recover(before, assertOwned)
      signal?.throwIfAborted()
      const change = transform(before.index)
      validateRemoteLibraryIndex(change.index)
      if (!change.key) return change.result
      if (!validLibraryStorageKey(change.key))
        throw new RemoteLibraryError('PATH_INVALID', 'Invalid library projection key')
      // Check all existing projection targets before admitting the authoritative index change.
      await this.command(libraryCommand(this.root, 'projection', change.key), signal)
      const bytes = json(change.index)
      if (bytes.length > REMOTE_LIBRARY_MAX_INDEX_BYTES)
        throw new RemoteLibraryError(
          'LIMIT_EXCEEDED',
          'Remote literature library index exceeds 4 MiB'
        )
      signal?.throwIfAborted()
      assertOwned()
      let intent = false
      let publicationStarted = false
      try {
        // From this point cancellation cannot release the writer ahead of unfinished fs writes.
        intent = true
        await this.target.workspace.projectHost.fs.writeAtomic(
          this.pendingPath(),
          json({ schemaVersion: 1, key: change.key }),
          { ifAbsent: true }
        )
        assertOwned()
        if (signal?.aborted) {
          await this.recover(await this.snapshot('read'), assertOwned)
          throw signal.reason
        }
        publicationStarted = true
        await this.target.workspace.projectHost.fs.writeAtomic(
          this.indexPath(),
          bytes,
          before.hash ? { expectedHash: before.hash } : { ifAbsent: true }
        )
        assertOwned()
        await this.project(change.index, change.key, assertOwned)
        await this.target.workspace.projectHost.fs.remove(this.pendingPath())
        assertOwned()
      } catch (cause) {
        if (signal?.aborted && !publicationStarted && cause === signal.reason) throw cause
        throw new RemoteLibraryError(
          intent ? 'COMMIT_UNCONFIRMED' : 'STORAGE_FAILED',
          'Remote library commit was not confirmed; reopen the library to repair its derived files without repeating the mutation',
          { cause }
        )
      }
      signal?.throwIfAborted()
      return change.result
    }, signal)
  }
  private async recover(snapshot: Snapshot, assertOwned: () => void): Promise<void> {
    if (!snapshot.pending) return
    await this.project(snapshot.index, snapshot.pending, assertOwned)
    await this.target.workspace.projectHost.fs.remove(this.pendingPath())
    assertOwned()
  }
  private async project(index: LibraryIndex, key: string, assertOwned: () => void): Promise<void> {
    assertOwned()
    const paper = index.papers.find((candidate) => candidate.storageKey === key)
    await this.command(libraryCommand(this.root, paper ? 'projection' : 'remove', key))
    assertOwned()
    if (!paper) return
    const path = posix.join(this.directory, 'papers', key)
    await this.target.workspace.projectHost.fs.writeAtomic(
      posix.join(path, 'meta.json'),
      paperProjection(paper)
    )
    assertOwned()
    await this.target.workspace.projectHost.fs.writeAtomic(
      posix.join(path, 'note.md'),
      Buffer.from(libraryNoteMarkdown(paper))
    )
    assertOwned()
  }
  private async locked<T>(
    operation: (assertOwned: () => void) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const input = signal ?? new AbortController().signal
    input.throwIfAborted()
    const lock = await acquireOwnedRemoteLock({
      root: this.directory,
      directory: posix.join(this.directory, '.locks'),
      basename: 'index.lock',
      openStdio: this.target.openLockStdio,
      signal: input
    })
    let lost: unknown
    let retired = false
    void lock.lost.catch((cause: unknown) => {
      lost = cause
      retired = true
    })
    const assertOwned = (): void => {
      if (retired)
        throw new RemoteLibraryError(
          'COMMIT_UNCONFIRMED',
          'Remote library writer connection was lost',
          { cause: lost }
        )
    }
    let outcome: { ok: true; value: T } | { ok: false; error: unknown }
    try {
      assertOwned()
      outcome = { ok: true, value: await operation(assertOwned) }
    } catch (error) {
      outcome = { ok: false, error }
    }
    try {
      await lock.release()
    } catch (error) {
      if (outcome.ok)
        throw new RemoteLibraryError(
          'COMMIT_UNCONFIRMED',
          'Remote library writer cleanup was not confirmed',
          { cause: error }
        )
    }
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }
  private indexPath(): string {
    return posix.join(this.directory, 'index.json')
  }
  private pendingPath(): string {
    return posix.join(this.directory, '.projection-pending.json')
  }
  private async snapshot(mode: 'read' | 'prepare', signal?: AbortSignal): Promise<Snapshot> {
    const raw = parseJson(await this.command(libraryCommand(this.root, mode), signal))
    if (!record(raw) || typeof raw.exists !== 'boolean')
      throw new RemoteLibraryError('FILE_INVALID', 'Malformed remote library storage receipt')
    if (!raw.exists) return { exists: false, index: createEmptyLibraryIndex() }
    const index = this.decodeFile(raw.index, REMOTE_LIBRARY_MAX_INDEX_BYTES)
    const pending = this.decodeFile(raw.pending, 2048)
    let key: string | undefined
    if (pending) {
      const parsed = parseJson(pending.bytes.toString('utf8'))
      if (
        !record(parsed) ||
        Object.keys(parsed).sort().join(',') !== 'key,schemaVersion' ||
        parsed.schemaVersion !== 1 ||
        !validLibraryStorageKey(parsed.key)
      )
        throw new RemoteLibraryError('FILE_INVALID', 'Remote library projection marker is invalid')
      key = parsed.key
    }
    return {
      exists: true,
      index: index
        ? validateRemoteLibraryIndex(
            parseJson(new TextDecoder('utf-8', { fatal: true }).decode(index.bytes))
          )
        : createEmptyLibraryIndex(),
      ...(index ? { hash: index.hash } : {}),
      ...(key ? { pending: key } : {})
    }
  }
  private decodeFile(value: unknown, limit: number): { bytes: Buffer; hash: string } | undefined {
    if (value === null) return undefined
    if (
      !record(value) ||
      typeof value.data !== 'string' ||
      value.data.length > Math.ceil(limit / 3) * 4 ||
      value.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data) ||
      typeof value.hash !== 'string'
    )
      throw new RemoteLibraryError('FILE_INVALID', 'Remote library file receipt is invalid')
    const bytes = Buffer.from(value.data, 'base64')
    if (bytes.length > limit)
      throw new RemoteLibraryError('LIMIT_EXCEEDED', 'Remote library bytes exceeded their bound')
    if (hash(bytes) !== value.hash || bytes.toString('base64') !== value.data)
      throw new RemoteLibraryError('FILE_INVALID', 'Remote library bytes changed during transport')
    return { bytes, hash: value.hash }
  }
  private async command(script: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const result = await this.target.workspace.execWithInput(script, {
      signal,
      timeoutMs: 30000,
      maxOutputBytes: Math.ceil((REMOTE_LIBRARY_MAX_INDEX_BYTES * 4) / 3) + 8192
    })
    signal?.throwIfAborted()
    if (result.code !== 0 || result.truncated || result.terminationReason) {
      const code =
        /PHI_LIBRARY:(PATH_INVALID|PERMISSION_DENIED|FILE_INVALID|LIMIT_EXCEEDED|STORAGE_FAILED)/.exec(
          result.stderr
        )?.[1]
      throw new RemoteLibraryError(
        (code as RemoteLibraryError['code']) ?? 'STORAGE_FAILED',
        'Selected server could not safely access the remote literature library'
      )
    }
    return result.stdout
  }
}
