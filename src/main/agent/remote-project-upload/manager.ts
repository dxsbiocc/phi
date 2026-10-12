import { randomUUID } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize, posix, relative, sep } from 'node:path'

import type {
  PrepareRemoteProjectUploadInput,
  RemoteProjectUploadFile,
  RemoteProjectUploadJob,
  StartRemoteProjectUploadOptions
} from '../../../shared/remoteProjectUploadTypes'
import { sameSourceIdentity } from '../transfer/manifest'
import { safeTransferText } from '../transfer/errors'
import { hashLocalFile, localSourceIdentity } from '../transfer/ssh-data-plane-local'
import type { RemoteSshSession } from '../wrappers/remote-ssh-session'

import { runRemoteProjectUpload } from './run'
export const REMOTE_PROJECT_UPLOAD_CONFIRM_BYTES = 1024 * 1024 * 1024
export const REMOTE_PROJECT_UPLOAD_CONFIRM_FILES = 200
export const REMOTE_PROJECT_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024 * 1024
export const REMOTE_PROJECT_UPLOAD_MAX_FILES = 5_000

export interface RemoteProjectUploadManagerOptions {
  session: RemoteSshSession
  remoteProjectRoot: string
  canonicalRemoteProjectRoot: string
  hostKey: string
  workspaceId: string
  idFactory?: () => string
  now?: () => number
  hashFile?: (path: string) => Promise<string>
}

type LocalUploadFile = Readonly<{
  localPath: string
  relativePath: string
  size: number
}>

function assertRemoteRoot(path: string, label: string): void {
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path || /[\0\r\n]/.test(path)) {
    throw new Error(`${label} must be a normalized absolute POSIX path`)
  }
}

function assertDestinationDirectory(path: string): string {
  if (path === '' || path === '.') return ''
  if (
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path === '..' ||
    path.startsWith('../') ||
    /[\0\r\n]/.test(path)
  ) {
    throw new Error('Upload destination must stay inside the remote project root')
  }
  return path
}

function assertLocalSelection(path: string): string {
  if (!isAbsolute(path) || /\0/.test(path) || path.split(sep).includes('..')) {
    throw new Error('Local upload source must be an absolute path without traversal')
  }
  return normalize(path)
}

function portableRelativePath(path: string): string {
  return path.split(sep).join('/')
}

async function enumerateSelection(path: string): Promise<LocalUploadFile[]> {
  const root = assertLocalSelection(path)
  const rootMetadata = await lstat(root)
  if (rootMetadata.isSymbolicLink())
    throw new Error('Local upload sources may not be symbolic links')
  if (rootMetadata.isFile()) {
    if (rootMetadata.size > REMOTE_PROJECT_UPLOAD_MAX_BYTES) {
      throw new Error('Upload exceeds the hard size limit of 1 TiB')
    }
    return [{ localPath: root, relativePath: basename(root), size: rootMetadata.size }]
  }
  if (!rootMetadata.isDirectory())
    throw new Error('Local upload sources must be regular files or directories')

  const rootName = basename(root)
  const files: LocalUploadFile[] = []
  let totalBytes = 0
  const append = (file: LocalUploadFile): void => {
    if (files.length >= REMOTE_PROJECT_UPLOAD_MAX_FILES) {
      throw new Error(`Upload exceeds the hard limit of ${REMOTE_PROJECT_UPLOAD_MAX_FILES} files`)
    }
    if (
      !Number.isSafeInteger(file.size) ||
      file.size > REMOTE_PROJECT_UPLOAD_MAX_BYTES - totalBytes
    ) {
      throw new Error('Upload exceeds the hard size limit of 1 TiB')
    }
    files.push(file)
    totalBytes += file.size
  }
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const localPath = join(directory, entry.name)
      const metadata = await lstat(localPath)
      if (metadata.isSymbolicLink()) {
        throw new Error('Local upload directories may not contain symbolic links')
      }
      if (metadata.isDirectory()) {
        await visit(localPath)
      } else if (metadata.isFile()) {
        append({
          localPath,
          relativePath: posix.join(rootName, portableRelativePath(relative(root, localPath))),
          size: metadata.size
        })
      } else {
        throw new Error('Local upload directories may only contain regular files and directories')
      }
    }
  }
  await visit(root)
  return files
}

export class RemoteProjectUploadManager {
  private readonly jobs = new Map<string, RemoteProjectUploadJob>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly listeners = new Set<(job: RemoteProjectUploadJob) => void>()
  private readonly idFactory: () => string
  private readonly now: () => number

  constructor(private readonly options: RemoteProjectUploadManagerOptions) {
    assertRemoteRoot(options.remoteProjectRoot, 'Remote project root')
    assertRemoteRoot(options.canonicalRemoteProjectRoot, 'Canonical remote project root')
    if (!options.hostKey || !options.workspaceId)
      throw new Error('Remote upload identity is required')
    this.idFactory = options.idFactory ?? randomUUID
    this.now = options.now ?? Date.now
  }

  async prepare(input: PrepareRemoteProjectUploadInput): Promise<RemoteProjectUploadJob> {
    if (input.sourcePaths.length === 0) throw new Error('Select at least one file or directory')
    const destinationDirectory = assertDestinationDirectory(input.destinationDirectory ?? '')
    const sourcePaths = Object.freeze(input.sourcePaths.map(assertLocalSelection))
    const enumerated: LocalUploadFile[] = []
    for (const sourcePath of sourcePaths) {
      enumerated.push(...(await enumerateSelection(sourcePath)))
      if (enumerated.length > REMOTE_PROJECT_UPLOAD_MAX_FILES) {
        throw new Error(`Upload exceeds the hard limit of ${REMOTE_PROJECT_UPLOAD_MAX_FILES} files`)
      }
    }
    if (enumerated.length === 0) throw new Error('Selected directories contain no files')
    const totalBytes = enumerated.reduce((sum, file) => sum + file.size, 0)
    if (!Number.isSafeInteger(totalBytes) || totalBytes > REMOTE_PROJECT_UPLOAD_MAX_BYTES) {
      throw new Error('Upload exceeds the hard size limit of 1 TiB')
    }

    const files: RemoteProjectUploadFile[] = []
    for (const file of enumerated) {
      const before = await localSourceIdentity(file.localPath)
      if (before.size !== file.size) {
        throw new Error('Local upload source changed during preparation')
      }
      const sha256 = this.options.hashFile
        ? await this.options.hashFile(file.localPath)
        : await hashLocalFile(file.localPath, 8 * 1024 * 1024)
      if (!/^[a-f0-9]{64}$/.test(sha256)) {
        throw new Error('Local upload SHA-256 is invalid')
      }
      if (!sameSourceIdentity(before, await localSourceIdentity(file.localPath))) {
        throw new Error('Local upload source changed while being hashed')
      }
      files.push({
        localPath: file.localPath,
        relativePath: file.relativePath,
        name: posix.basename(file.relativePath),
        size: file.size,
        sha256,
        resolution: 'pending'
      })
    }

    const createdAt = this.now()
    const job: RemoteProjectUploadJob = {
      id: this.idFactory(),
      sourcePaths,
      status: 'queued',
      destinationDirectory,
      totalFiles: files.length,
      totalBytes,
      bytesTransferred: 0,
      bytesPerSecond: 0,
      requiresConfirmation:
        totalBytes > REMOTE_PROJECT_UPLOAD_CONFIRM_BYTES ||
        files.length > REMOTE_PROJECT_UPLOAD_CONFIRM_FILES,
      confirmed: false,
      files,
      createdAt,
      updatedAt: createdAt
    }
    if (this.jobs.has(job.id)) throw new Error('Upload job id already exists')
    this.jobs.set(job.id, job)
    this.notify(job)
    return job
  }

  async start(
    jobId: string,
    options: StartRemoteProjectUploadOptions = {}
  ): Promise<RemoteProjectUploadJob> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('Upload job was not found')
    if (job.status !== 'queued') throw new Error('Only queued upload jobs can be started')
    const confirmed = job.confirmed || options.confirmed === true
    if (job.requiresConfirmation && !confirmed) {
      throw new Error('Upload requires confirmation because it exceeds 1 GiB or 200 files')
    }

    const update = (patch: Partial<RemoteProjectUploadJob>): RemoteProjectUploadJob => {
      const current = this.jobs.get(jobId)
      if (!current) throw new Error('Upload job was not found')
      const updated = { ...current, ...patch, updatedAt: this.now() }
      this.jobs.set(jobId, updated)
      this.notify(updated)
      return updated
    }
    const updateFile = (index: number, file: RemoteProjectUploadFile): RemoteProjectUploadJob => {
      const current = this.jobs.get(jobId)
      if (!current) throw new Error('Upload job was not found')
      const files = [...current.files]
      files[index] = file
      return update({ files })
    }
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    const started = update({ status: 'verifying', confirmed, error: undefined })
    try {
      return await runRemoteProjectUpload({
        session: this.options.session,
        remoteProjectRoot: this.options.remoteProjectRoot,
        canonicalRemoteProjectRoot: this.options.canonicalRemoteProjectRoot,
        hostKey: this.options.hostKey,
        workspaceId: this.options.workspaceId,
        job: started,
        signal: controller.signal,
        update,
        updateFile
      })
    } catch (error) {
      const cancelled = controller.signal.aborted || (error as Error)?.name === 'AbortError'
      return update({
        status: cancelled ? 'cancelled' : 'failed',
        bytesPerSecond: 0,
        error: cancelled ? undefined : safeTransferText(error)
      })
    } finally {
      this.controllers.delete(jobId)
    }
  }

  cancel(jobId: string): RemoteProjectUploadJob {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('Upload job was not found')
    if (job.status === 'completed' || job.status === 'cancelled') return job
    this.controllers.get(jobId)?.abort()
    const cancelled: RemoteProjectUploadJob = {
      ...job,
      status: 'cancelled',
      bytesPerSecond: 0,
      error: undefined,
      updatedAt: this.now()
    }
    this.jobs.set(jobId, cancelled)
    this.notify(cancelled)
    return cancelled
  }

  async retry(
    jobId: string,
    options: StartRemoteProjectUploadOptions = {}
  ): Promise<RemoteProjectUploadJob> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('Upload job was not found')
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      throw new Error('Only failed or cancelled upload jobs can be retried')
    }
    const queued: RemoteProjectUploadJob = {
      ...job,
      status: 'queued',
      bytesTransferred: 0,
      bytesPerSecond: 0,
      confirmed: job.confirmed || options.confirmed === true,
      error: undefined,
      files: job.files.map((file) => ({
        localPath: file.localPath,
        relativePath: file.relativePath,
        name: file.name,
        size: file.size,
        sha256: file.sha256,
        resolution: 'pending'
      })),
      updatedAt: this.now()
    }
    this.jobs.set(jobId, queued)
    this.notify(queued)
    return this.start(jobId, { confirmed: queued.confirmed })
  }

  subscribe(listener: (job: RemoteProjectUploadJob) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  list(): readonly RemoteProjectUploadJob[] {
    return [...this.jobs.values()]
  }

  private notify(job: RemoteProjectUploadJob): void {
    for (const listener of this.listeners) {
      try {
        listener(job)
      } catch {
        // Observers must not be able to fail or cancel a transfer.
      }
    }
  }
}
