import { createHash } from 'node:crypto'

import type {
  RemoteProjectUploadFile,
  RemoteProjectUploadJob
} from '../../../shared/remoteProjectUploadTypes'
import { TransferError } from '../transfer/errors'
import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
import { hashLocalFile } from '../transfer/ssh-data-plane-local'
import { resolveRemoteDestination } from './remote-destination'

export type UploadJobUpdate = (patch: Partial<RemoteProjectUploadJob>) => RemoteProjectUploadJob
export type UploadFileUpdate = (
  index: number,
  file: RemoteProjectUploadFile
) => RemoteProjectUploadJob

export interface RunRemoteProjectUploadOptions {
  session: RemoteSshSession
  remoteProjectRoot: string
  canonicalRemoteProjectRoot: string
  hostKey: string
  workspaceId: string
  job: RemoteProjectUploadJob
  signal: AbortSignal
  update: UploadJobUpdate
  updateFile: UploadFileUpdate
}

export async function runRemoteProjectUpload(
  options: RunRemoteProjectUploadOptions
): Promise<RemoteProjectUploadJob> {
  let completedBytes = 0
  let current = options.job
  for (let index = 0; index < current.files.length; index += 1) {
    options.signal.throwIfAborted()
    const file = current.files[index]!
    let collisionRetries = 0
    while (true) {
      current = options.update({ status: 'verifying' })
      const destination = await resolveRemoteDestination({
        session: options.session,
        remoteProjectRoot: options.remoteProjectRoot,
        canonicalRemoteProjectRoot: options.canonicalRemoteProjectRoot,
        destinationDirectory: current.destinationDirectory,
        relativePath: file.relativePath,
        sha256: file.sha256,
        signal: options.signal
      })
      current = options.updateFile(index, {
        ...file,
        destinationPath: destination.path,
        ...(destination.renamed
          ? { originalDestinationPath: destination.originalPath, resolution: 'renamed' as const }
          : {})
      })
      if (destination.action === 'reuse') {
        completedBytes += file.size
        const currentSha256 = await hashLocalFile(
          file.localPath,
          8 * 1024 * 1024,
          undefined,
          options.signal
        )
        if (currentSha256 !== file.sha256) {
          throw new Error('Local source changed after preparation')
        }
        current = options.updateFile(index, {
          ...current.files[index]!,
          resolution: 'reused'
        })
        current = options.update({ bytesTransferred: completedBytes, bytesPerSecond: 0 })
        break
      }

      const destinationKey = createHash('sha256')
        .update(destination.path)
        .digest('hex')
        .slice(0, 24)
      current = options.update({ status: 'uploading' })
      try {
        await options.session.uploadFile(file.localPath, destination.path, {
          transferId: `${current.id}-${index}-${destinationKey}`,
          expectedSha256: file.sha256,
          remoteRoot: options.remoteProjectRoot,
          canonicalRoot: options.canonicalRemoteProjectRoot,
          hostKey: options.hostKey,
          workspaceId: options.workspaceId,
          signal: options.signal,
          onEvent: (event) => {
            const activeBytes = Math.min(file.size, Math.max(0, event.bytesTransferred))
            current = options.update({
              status: event.state === 'verifying' ? 'verifying' : 'uploading',
              bytesTransferred: Math.min(current.totalBytes, completedBytes + activeBytes),
              bytesPerSecond: event.smoothedBytesPerSecond || event.instantaneousBytesPerSecond || 0
            })
          }
        })
      } catch (error) {
        if (
          error instanceof TransferError &&
          error.code === 'DESTINATION_EXISTS' &&
          collisionRetries < 32
        ) {
          collisionRetries += 1
          continue
        }
        throw error
      }
      completedBytes += file.size
      current = options.updateFile(index, {
        ...current.files[index]!,
        resolution: destination.renamed ? 'renamed' : 'uploaded'
      })
      current = options.update({ bytesTransferred: completedBytes, bytesPerSecond: 0 })
      break
    }
  }
  return options.update({
    status: 'completed',
    bytesTransferred: current.totalBytes,
    bytesPerSecond: 0
  })
}
