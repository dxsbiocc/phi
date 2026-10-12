import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  REMOTE_PROJECT_UPLOAD_MAX_BYTES,
  RemoteProjectUploadManager
} from '../src/main/agent/remote-project-upload/manager'
import { RemoteProjectUploadService } from '../src/main/agent/remote-project-upload/service'
import { TransferError } from '../src/main/agent/transfer/errors'
import { createLocalShellSession } from './helpers/localShellSession'

test('prepare enumerates regular files, preserves a selected directory tree, and hashes each file', async () => {
  const local = await mkdtemp(join(tmpdir(), 'phi-project-upload-local-'))
  const remote = await mkdtemp(join(tmpdir(), 'phi-project-upload-remote-'))
  try {
    const selected = join(local, 'dataset')
    await mkdir(join(selected, 'nested'), { recursive: true })
    await writeFile(join(selected, 'alpha.txt'), 'alpha')
    await writeFile(join(selected, 'nested', 'beta.txt'), 'beta')
    const manager = new RemoteProjectUploadManager({
      session: createLocalShellSession(remote),
      remoteProjectRoot: remote,
      canonicalRemoteProjectRoot: remote,
      hostKey: 'test-host',
      workspaceId: 'test-workspace',
      idFactory: () => 'upload-1'
    })

    const job = await manager.prepare({ sourcePaths: [`${selected}/.`] })

    assert.equal(job.id, 'upload-1')
    assert.deepEqual(job.sourcePaths, [selected])
    assert.equal(job.status, 'queued')
    assert.equal(job.totalFiles, 2)
    assert.equal(job.totalBytes, 9)
    assert.equal(job.requiresConfirmation, false)
    assert.deepEqual(
      job.files.map(({ relativePath, sha256 }) => ({ relativePath, sha256 })),
      [
        {
          relativePath: 'dataset/alpha.txt',
          sha256: createHash('sha256').update('alpha').digest('hex')
        },
        {
          relativePath: 'dataset/nested/beta.txt',
          sha256: createHash('sha256').update('beta').digest('hex')
        }
      ]
    )
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
})
test('start uploads directly beneath the selected remote directory through the session transport', async () => {
  const local = await mkdtemp(join(tmpdir(), 'phi-project-upload-local-'))
  const remote = await mkdtemp(join(tmpdir(), 'phi-project-upload-remote-'))
  try {
    const selected = join(local, 'dataset')
    await mkdir(join(selected, 'nested'), { recursive: true })
    await writeFile(join(selected, 'nested', 'sample.txt'), 'sample bytes')
    const session = createLocalShellSession(remote)
    const manager = new RemoteProjectUploadManager({
      session,
      remoteProjectRoot: remote,
      canonicalRemoteProjectRoot: await realpath(remote),
      hostKey: 'test-host',
      workspaceId: 'test-workspace',
      idFactory: () => 'upload-direct'
    })
    await manager.prepare({ sourcePaths: [selected], destinationDirectory: 'inputs' })

    const completed = await manager.start('upload-direct')

    assert.equal(completed.status, 'completed', completed.error)
    assert.equal(completed.bytesTransferred, completed.totalBytes)
    assert.deepEqual(
      completed.files.map(({ destinationPath, resolution }) => ({ destinationPath, resolution })),
      [
        {
          destinationPath: join(remote, 'inputs', 'dataset', 'nested', 'sample.txt'),
          resolution: 'uploaded'
        }
      ]
    )
    assert.equal(session.uploads.length, 1)
    assert.equal(session.uploads[0]?.options?.expectedSha256, completed.files[0]?.sha256)
    assert.equal(session.uploads[0]?.options?.remoteRoot, remote)
    assert.equal(session.uploads[0]?.options?.canonicalRoot, await realpath(remote))
    assert.equal(session.uploads[0]?.options?.reuseVerifiedDestination, undefined)
    assert.ok(session.uploads[0]?.options?.signal instanceof AbortSignal)
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
})

test('existing remote content is reused by hash or uploaded with a numeric suffix without overwrite', async () => {
  const local = await mkdtemp(join(tmpdir(), 'phi-project-upload-local-'))
  const remote = await mkdtemp(join(tmpdir(), 'phi-project-upload-remote-'))
  try {
    const source = join(local, 'sample.txt')
    const existing = join(remote, 'sample.txt')
    await writeFile(source, 'same bytes')
    await writeFile(existing, 'same bytes')
    const session = createLocalShellSession(remote)
    let id = 0
    const manager = new RemoteProjectUploadManager({
      session,
      remoteProjectRoot: remote,
      canonicalRemoteProjectRoot: await realpath(remote),
      hostKey: 'test-host',
      workspaceId: 'test-workspace',
      idFactory: () => `collision-${++id}`
    })

    const reusable = await manager.prepare({ sourcePaths: [source] })
    const reused = await manager.start(reusable.id)

    assert.equal(reused.status, 'completed', reused.error)
    assert.equal(reused.files[0]?.resolution, 'reused')
    assert.equal(reused.files[0]?.destinationPath, existing)
    assert.equal(session.uploads.length, 0)

    await writeFile(source, 'different bytes')
    const colliding = await manager.prepare({ sourcePaths: [source] })
    const renamed = await manager.start(colliding.id)

    assert.equal(renamed.status, 'completed', renamed.error)
    assert.equal(renamed.files[0]?.resolution, 'renamed')
    assert.equal(renamed.files[0]?.originalDestinationPath, existing)
    assert.equal(renamed.files[0]?.destinationPath, join(remote, 'sample (1).txt'))
    assert.equal(session.uploads.length, 1)
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
})

test('concurrent same-name uploads re-resolve a publish race instead of failing or overwriting', async () => {
  const local = await mkdtemp(join(tmpdir(), 'phi-project-upload-local-'))
  const remote = await mkdtemp(join(tmpdir(), 'phi-project-upload-remote-'))
  try {
    const leftDir = join(local, 'left')
    const rightDir = join(local, 'right')
    await mkdir(leftDir)
    await mkdir(rightDir)
    const left = join(leftDir, 'sample.txt')
    const right = join(rightDir, 'sample.txt')
    await writeFile(left, 'left bytes')
    await writeFile(right, 'right bytes')
    const leftSession = createLocalShellSession(remote)
    const rightSession = createLocalShellSession(remote)
    let arrivals = 0
    let release!: () => void
    let published!: () => void
    const bothAllocated = new Promise<void>((resolve) => {
      release = resolve
    })
    const firstPublished = new Promise<void>((resolve) => {
      published = resolve
    })
    const leftUpload = leftSession.uploadFile.bind(leftSession)
    leftSession.uploadFile = async (localPath, remotePath, options) => {
      arrivals += 1
      if (arrivals === 2) release()
      await bothAllocated
      await leftUpload(localPath, remotePath, options)
      published()
    }
    const rightUpload = rightSession.uploadFile.bind(rightSession)
    rightSession.uploadFile = async (localPath, remotePath, options) => {
      arrivals += 1
      if (arrivals === 2) release()
      await bothAllocated
      await firstPublished
      try {
        await access(remotePath)
        throw new TransferError('DESTINATION_EXISTS', 'destination claimed concurrently')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await rightUpload(localPath, remotePath, options)
    }
    const canonical = await realpath(remote)
    const leftManager = new RemoteProjectUploadManager({
      session: leftSession,
      remoteProjectRoot: remote,
      canonicalRemoteProjectRoot: canonical,
      hostKey: 'concurrent-host',
      workspaceId: 'concurrent-workspace',
      idFactory: () => 'concurrent-left'
    })
    const rightManager = new RemoteProjectUploadManager({
      session: rightSession,
      remoteProjectRoot: remote,
      canonicalRemoteProjectRoot: canonical,
      hostKey: 'concurrent-host',
      workspaceId: 'concurrent-workspace',
      idFactory: () => 'concurrent-right'
    })
    await Promise.all([
      leftManager.prepare({ sourcePaths: [left] }),
      rightManager.prepare({ sourcePaths: [right] })
    ])

    const [leftResult, rightResult] = await Promise.all([
      leftManager.start('concurrent-left'),
      rightManager.start('concurrent-right')
    ])

    assert.equal(leftResult.status, 'completed', leftResult.error)
    assert.equal(rightResult.status, 'completed', rightResult.error)
    assert.deepEqual(
      new Set([
        await readFile(join(remote, 'sample.txt'), 'utf8'),
        await readFile(join(remote, 'sample (1).txt'), 'utf8')
      ]),
      new Set(['left bytes', 'right bytes'])
    )
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
})

test('transfer events update aggregate progress and preserve transport throttling', async () => {
  const local = await mkdtemp(join(tmpdir(), 'phi-project-upload-local-'))
  const remote = await mkdtemp(join(tmpdir(), 'phi-project-upload-remote-'))
  try {
    const source = join(local, 'progress.bin')
    await writeFile(source, '123456')
    const session = createLocalShellSession(remote)
    const upload = session.uploadFile.bind(session)
    session.uploadFile = async (localPath, remotePath, options) => {
      options?.onEvent?.({
        transferId: options.transferId ?? 'progress',
        direction: 'upload',
        state: 'transferring',
        bytesTransferred: 3,
        totalBytes: 6,
        resumedFrom: 0,
        instantaneousBytesPerSecond: 100,
        smoothedBytesPerSecond: 80
      })
      options?.onEvent?.({
        transferId: options.transferId ?? 'progress',
        direction: 'upload',
        state: 'verifying',
        bytesTransferred: 6,
        totalBytes: 6,
        resumedFrom: 0,
        instantaneousBytesPerSecond: 60,
        smoothedBytesPerSecond: 40
      })
      await upload(localPath, remotePath, options)
    }
    const manager = new RemoteProjectUploadManager({
      session,
      remoteProjectRoot: remote,
      canonicalRemoteProjectRoot: await realpath(remote),
      hostKey: 'test-host',
      workspaceId: 'test-workspace',
      idFactory: () => 'progress-job'
    })
    const observed: Array<{ status: string; bytes: number; speed: number }> = []
    manager.subscribe((job) => {
      observed.push({
        status: job.status,
        bytes: job.bytesTransferred,
        speed: job.bytesPerSecond
      })
    })
    await manager.prepare({ sourcePaths: [source] })

    const completed = await manager.start('progress-job')

    assert.equal(completed.status, 'completed', completed.error)
    assert.ok(
      observed.some(
        ({ status, bytes, speed }) => status === 'uploading' && bytes === 3 && speed === 80
      )
    )
    assert.ok(
      observed.some(
        ({ status, bytes, speed }) => status === 'verifying' && bytes === 6 && speed === 40
      )
    )
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
})

test('cancel aborts the active transport and retry restarts a cancelled job', async () => {
  const local = await mkdtemp(join(tmpdir(), 'phi-project-upload-local-'))
  const remote = await mkdtemp(join(tmpdir(), 'phi-project-upload-remote-'))
  try {
    const source = join(local, 'cancel.bin')
    await writeFile(source, 'cancel me')
    const session = createLocalShellSession(remote)
    const upload = session.uploadFile.bind(session)
    let attempt = 0
    let started!: () => void
    const active = new Promise<void>((resolve) => {
      started = resolve
    })
    session.uploadFile = async (localPath, remotePath, options) => {
      attempt += 1
      if (attempt > 1) {
        await upload(localPath, remotePath, options)
        return
      }
      started()
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => {
          const error = new Error('cancelled')
          error.name = 'AbortError'
          reject(error)
        }
        options?.signal?.addEventListener('abort', abort, { once: true })
        if (options?.signal?.aborted) abort()
      })
    }
    const manager = new RemoteProjectUploadManager({
      session,
      remoteProjectRoot: remote,
      canonicalRemoteProjectRoot: await realpath(remote),
      hostKey: 'test-host',
      workspaceId: 'test-workspace',
      idFactory: () => 'cancel-job'
    })
    await manager.prepare({ sourcePaths: [source] })

    const running = manager.start('cancel-job')
    await active
    const cancelling = manager.cancel('cancel-job')
    const cancelled = await running

    assert.equal(cancelling.status, 'cancelled')
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.error, undefined)

    const completed = await manager.retry('cancel-job')

    assert.equal(completed.status, 'completed', completed.error)
    assert.equal(attempt, 2)
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
})

test('confirmation is required only above the 1 GiB boundary', async () => {
  const local = await mkdtemp(join(tmpdir(), 'phi-project-upload-local-'))
  const remote = await mkdtemp(join(tmpdir(), 'phi-project-upload-remote-'))
  try {
    const source = join(local, 'sparse.bin')
    await writeFile(source, '')
    await truncate(source, 1024 * 1024 * 1024)
    let id = 0
    const manager = new RemoteProjectUploadManager({
      session: createLocalShellSession(remote),
      remoteProjectRoot: remote,
      canonicalRemoteProjectRoot: await realpath(remote),
      hostKey: 'test-host',
      workspaceId: 'test-workspace',
      idFactory: () => `threshold-${++id}`,
      hashFile: async () => '0'.repeat(64)
    })

    const exact = await manager.prepare({ sourcePaths: [source] })
    assert.equal(exact.requiresConfirmation, false)

    await truncate(source, 1024 * 1024 * 1024 + 1)
    const above = await manager.prepare({ sourcePaths: [source] })
    assert.equal(above.requiresConfirmation, true)
    await assert.rejects(manager.start(above.id), /requires confirmation/)
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
})

test('local and remote symbolic links are rejected without touching their targets', async () => {
  const local = await mkdtemp(join(tmpdir(), 'phi-project-upload-local-'))
  const remote = await mkdtemp(join(tmpdir(), 'phi-project-upload-remote-'))
  const outside = await mkdtemp(join(tmpdir(), 'phi-project-upload-outside-'))
  try {
    const source = join(local, 'payload.txt')
    const localLink = join(local, 'payload-link.txt')
    const outsideTarget = join(outside, 'target.txt')
    const remoteLink = join(remote, 'payload.txt')
    await writeFile(source, 'new bytes')
    await symlink(source, localLink)
    await writeFile(outsideTarget, 'protected bytes')
    await symlink(outsideTarget, remoteLink)
    const session = createLocalShellSession(remote)
    let id = 0
    const manager = new RemoteProjectUploadManager({
      session,
      remoteProjectRoot: remote,
      canonicalRemoteProjectRoot: await realpath(remote),
      hostKey: 'test-host',
      workspaceId: 'test-workspace',
      idFactory: () => `symlink-${++id}`
    })

    await assert.rejects(manager.prepare({ sourcePaths: [localLink] }), /symbolic links/)
    const prepared = await manager.prepare({ sourcePaths: [source] })
    const failed = await manager.start(prepared.id)

    assert.equal(failed.status, 'failed')
    assert.match(failed.error ?? '', /UNSAFE_DESTINATION/)
    assert.equal(await readFile(outsideTarget, 'utf8'), 'protected bytes')
    assert.equal(session.uploads.length, 0)
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('confirmation is required only above the 200 file boundary', async () => {
  const local = await mkdtemp(join(tmpdir(), 'phi-project-upload-local-'))
  const remote = await mkdtemp(join(tmpdir(), 'phi-project-upload-remote-'))
  try {
    const selected = join(local, 'batch')
    await mkdir(selected)
    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        writeFile(join(selected, `file-${index.toString().padStart(3, '0')}.txt`), '')
      )
    )
    let id = 0
    const manager = new RemoteProjectUploadManager({
      session: createLocalShellSession(remote),
      remoteProjectRoot: remote,
      canonicalRemoteProjectRoot: await realpath(remote),
      hostKey: 'test-host',
      workspaceId: 'test-workspace',
      idFactory: () => `count-threshold-${++id}`,
      hashFile: async () => '0'.repeat(64)
    })

    const exact = await manager.prepare({ sourcePaths: [selected] })
    assert.equal(exact.totalFiles, 200)
    assert.equal(exact.requiresConfirmation, false)

    await writeFile(join(selected, 'file-200.txt'), '')
    const above = await manager.prepare({ sourcePaths: [selected] })
    assert.equal(above.totalFiles, 201)
    assert.equal(above.requiresConfirmation, true)
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
})

test('a local source changed after prepare cannot be silently reused', async () => {
  const local = await mkdtemp(join(tmpdir(), 'phi-project-upload-local-'))
  const remote = await mkdtemp(join(tmpdir(), 'phi-project-upload-remote-'))
  try {
    const source = join(local, 'sample.txt')
    const existing = join(remote, 'sample.txt')
    await writeFile(source, 'first')
    await writeFile(existing, 'first')
    const session = createLocalShellSession(remote)
    const manager = new RemoteProjectUploadManager({
      session,
      remoteProjectRoot: remote,
      canonicalRemoteProjectRoot: await realpath(remote),
      hostKey: 'test-host',
      workspaceId: 'test-workspace',
      idFactory: () => 'changed-source'
    })
    await manager.prepare({ sourcePaths: [source] })
    await writeFile(source, 'other')

    const failed = await manager.start('changed-source')

    assert.equal(failed.status, 'failed')
    assert.match(failed.error ?? '', /changed after preparation/)
    assert.equal(await readFile(existing, 'utf8'), 'first')
    assert.equal(session.uploads.length, 0)
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
})

test('retry restarts a failed transport while keeping the resumable transfer identity', async () => {
  const local = await mkdtemp(join(tmpdir(), 'phi-project-upload-local-'))
  const remote = await mkdtemp(join(tmpdir(), 'phi-project-upload-remote-'))
  try {
    const source = join(local, 'retry.bin')
    await writeFile(source, 'retry me')
    const session = createLocalShellSession(remote)
    const upload = session.uploadFile.bind(session)
    const transferIds: string[] = []
    let attempt = 0
    session.uploadFile = async (localPath, remotePath, options) => {
      attempt += 1
      transferIds.push(options?.transferId ?? '')
      if (attempt === 1) throw new Error('network unavailable')
      await upload(localPath, remotePath, options)
    }
    const manager = new RemoteProjectUploadManager({
      session,
      remoteProjectRoot: remote,
      canonicalRemoteProjectRoot: await realpath(remote),
      hostKey: 'test-host',
      workspaceId: 'test-workspace',
      idFactory: () => 'failed-job'
    })
    await manager.prepare({ sourcePaths: [source] })

    const failed = await manager.start('failed-job')
    assert.equal(failed.status, 'failed')
    assert.match(failed.error ?? '', /network unavailable/)

    const completed = await manager.retry('failed-job')

    assert.equal(completed.status, 'completed', completed.error)
    assert.equal(transferIds.length, 2)
    assert.equal(transferIds[0], transferIds[1])
    assert.match(transferIds[0]!, /^failed-job-0-[a-f0-9]{24}$/)
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
})

test('a completed upload job cannot be bound through a different project identity', async () => {
  const local = await mkdtemp(join(tmpdir(), 'phi-project-upload-local-'))
  const remote = await mkdtemp(join(tmpdir(), 'phi-project-upload-remote-'))
  try {
    const source = join(local, 'sample.txt')
    await writeFile(source, 'sample')
    const canonical = await realpath(remote)
    const service = new RemoteProjectUploadService({
      connectProject: async (projectId) => ({
        session: createLocalShellSession(remote),
        remoteProjectRoot: remote,
        canonicalRemoteProjectRoot: canonical,
        hostKey: `host-${projectId}`,
        workspaceId: `workspace-${projectId}`
      })
    })
    const prepared = await service.prepare('project-a', { sourcePaths: [source] })

    await assert.rejects(service.wait('project-b', prepared.id), /does not belong to project/)
    await service.start('project-a', prepared.id)
    const completed = await service.wait('project-a', prepared.id)
    assert.equal(completed.status, 'completed')
    await service.dispose()
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
})

test('the hard byte limit stops sparse files before hashing or queueing them', async () => {
  const local = await mkdtemp(join(tmpdir(), 'phi-project-upload-local-'))
  const remote = await mkdtemp(join(tmpdir(), 'phi-project-upload-remote-'))
  try {
    const source = join(local, 'too-large.bin')
    await writeFile(source, '')
    await truncate(source, REMOTE_PROJECT_UPLOAD_MAX_BYTES + 1)
    let hashCalls = 0
    const manager = new RemoteProjectUploadManager({
      session: createLocalShellSession(remote),
      remoteProjectRoot: remote,
      canonicalRemoteProjectRoot: await realpath(remote),
      hostKey: 'bounded-host',
      workspaceId: 'bounded-workspace',
      hashFile: async () => {
        hashCalls += 1
        return 'a'.repeat(64)
      }
    })

    await assert.rejects(manager.prepare({ sourcePaths: [source] }), /hard size limit of 1 TiB/)
    assert.equal(hashCalls, 0)
    assert.deepEqual(manager.list(), [])
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
})
