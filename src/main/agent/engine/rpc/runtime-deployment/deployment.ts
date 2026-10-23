import { createHash } from 'node:crypto'
import { shellQuote } from '../../../wrappers/remote-ssh-session'
import { ensureCachedRemoteOmp } from './artifact-cache'
import { REMOTE_OMP_MANIFEST, selectRemoteOmpAsset } from './manifest'
import {
  activateCommand,
  deploymentPaths,
  deploymentResult,
  prepareCommand,
  reuseCommand,
  runDeploymentCommand,
  spaceCommand
} from './remote-commands'
import {
  RemoteOmpDeploymentError,
  type RemoteOmpDeployment,
  type RemoteOmpDeploymentOptions
} from './types'

// Different sessions can request the same deployment simultaneously. Serialize the complete
// check/upload/activate transaction, not only the transfer, to protect its stable resume path.
const activeDeployments = new Map<string, Promise<void>>()

async function waitForDeployment(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!signal) return previous
  let aborted!: () => void
  try {
    await Promise.race([
      previous,
      new Promise<never>((_resolve, reject) => {
        aborted = () => reject(signal.reason)
        signal.addEventListener('abort', aborted, { once: true })
        if (signal.aborted) aborted()
      })
    ])
  } finally {
    signal.removeEventListener('abort', aborted)
  }
}

export async function ensureRemoteOmpDeployment(
  options: RemoteOmpDeploymentOptions
): Promise<RemoteOmpDeployment> {
  const key = `${options.uploadOptions?.hostKey ?? ''}\0${options.runtimeRoot}`
  const previous = activeDeployments.get(key) ?? Promise.resolve()
  let release!: () => void
  const finished = new Promise<void>((resolve) => {
    release = resolve
  })
  const current = previous.then(() => finished)
  activeDeployments.set(key, current)
  void current.then(() => {
    if (activeDeployments.get(key) === current) activeDeployments.delete(key)
  })
  try {
    await waitForDeployment(previous, options.signal)
    options.signal?.throwIfAborted()
    return await deploy(options)
  } finally {
    release()
  }
}

async function deploy(options: RemoteOmpDeploymentOptions): Promise<RemoteOmpDeployment> {
  const { runtimeHost: host, signal } = options
  const manifest = options.manifest ?? REMOTE_OMP_MANIFEST
  const { key, asset } = selectRemoteOmpAsset(
    manifest,
    options.desktopVersion,
    host.capabilities().platform
  )
  const paths = deploymentPaths(options.runtimeRoot, manifest.version, asset.sha256)
  const run = (command: string): Promise<string> =>
    runDeploymentCommand(host, paths, command, signal)
  options.onProgress?.({ phase: 'checking' })
  await run(prepareCommand(paths))
  if (
    (await run(reuseCommand(paths, asset.sha256, manifest.version))).trim() === 'PHI_OMP_REUSABLE'
  ) {
    options.onProgress?.({ phase: 'ready' })
    return deploymentResult(paths, manifest.version, true)
  }
  if (!host.transfer) {
    throw new RemoteOmpDeploymentError(
      'INVALID_ARGUMENT',
      'Runtime host has no streaming file transfer transport.'
    )
  }
  options.onProgress?.({ phase: 'downloading', bytesTransferred: 0 })
  const cached = await ensureCachedRemoteOmp({
    cacheDir: options.cacheDir,
    version: manifest.version,
    platform: key,
    asset,
    fetchImpl: options.fetchImpl,
    signal,
    onProgress: ({ bytesReceived, totalBytes, attempt }) =>
      options.onProgress?.({
        phase: 'downloading',
        bytesTransferred: bytesReceived,
        totalBytes,
        attempt
      })
  })
  await run(spaceCommand(paths, cached.size))
  const hostKey = options.uploadOptions?.hostKey
  // Without an explicit host identity, let WorkspaceHost derive its usual host-specific ID.
  const transferId = hostKey
    ? `omp-${createHash('sha256').update(hostKey).update('\0').update(paths.staging).update('\0').update(asset.sha256).digest('hex').slice(0, 40)}`
    : undefined
  try {
    signal?.throwIfAborted()
    options.onProgress?.({ phase: 'uploading', bytesTransferred: 0, totalBytes: cached.size })
    await host.transfer.uploadFile(cached.localPath, paths.staging, {
      ...options.uploadOptions,
      transferId,
      expectedSha256: asset.sha256,
      signal,
      reuseVerifiedDestination: true,
      onEvent: (transfer) =>
        options.onProgress?.({
          phase: 'uploading',
          bytesTransferred: transfer.bytesTransferred,
          totalBytes: transfer.totalBytes ?? undefined,
          transfer
        })
    })
    signal?.throwIfAborted()
    options.onProgress?.({ phase: 'verifying' })
    await run(activateCommand(paths, asset.sha256, manifest.version))
    options.onProgress?.({ phase: 'ready' })
    return deploymentResult(paths, manifest.version, false)
  } catch (error) {
    // The transfer manager owns resumable partials. Remove only a published, unactivated file.
    await runDeploymentCommand(host, paths, `rm -f -- ${shellQuote(paths.staging)}`).catch(
      () => undefined
    )
    signal?.throwIfAborted()
    if (!(error instanceof RemoteOmpDeploymentError) && error instanceof Error) {
      if (/no space left|disk quota|permission denied|read-only file system/i.test(error.message)) {
        throw new RemoteOmpDeploymentError(
          /no space left|disk quota/i.test(error.message)
            ? 'INSUFFICIENT_SPACE'
            : 'PERMISSION_DENIED',
          `${error.message}. Check the server runtime root setting (${paths.root}).`,
          { cause: error }
        )
      }
    }
    throw error
  }
}
