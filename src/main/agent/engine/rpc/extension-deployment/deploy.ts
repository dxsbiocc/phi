import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { shellQuote as q } from '../../../wrappers/remote-ssh-session'
import {
  deploymentReadyMarkerCheckCommand,
  deploymentReadyMarkerPath,
  phiExtensionReadyMarkerIdentity,
  writeDeploymentReadyMarkerCommand
} from '../deployment-ready-marker'
import { createPhiExtensionArchive } from './archive'
import { validatePhiExtensionBundle } from './bundle'
import { unpackBundleCommand } from './remote-archive'
import { privateRemotePrefix } from './remote-commands'
import type { ExtensionDeploymentOptions, PhiExtensionDeployment } from './types'
import { cacheExtensionSnapshot } from './snapshot-cache'
import { acquireExtensionLock, type ExtensionLock } from './remote-lock'

const deployments = new Map<string, Promise<void>>()

async function wait(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  let cancelled: (() => void) | undefined
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        cancelled = () => reject(signal?.reason)
        signal?.addEventListener('abort', cancelled, { once: true })
        if (signal?.aborted) cancelled()
      })
    ])
  } finally {
    if (cancelled) signal?.removeEventListener('abort', cancelled)
  }
}

export async function ensurePhiExtensionDeployment(
  options: ExtensionDeploymentOptions
): Promise<PhiExtensionDeployment> {
  validatePhiExtensionBundle(options.bundle)
  const key = `${options.uploadOptions?.hostKey ?? ''}\0${options.runtimeRoot}\0${options.bundle.contentHash}`
  const previous = deployments.get(key) ?? Promise.resolve()
  // Create the release promise before waiting; a cancelled queued transaction must
  // still remain behind the predecessor until that predecessor releases its lock.
  let finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const current = previous.then(() => done)
  deployments.set(key, current)
  void current.then(() => {
    if (deployments.get(key) === current) deployments.delete(key)
  })
  try {
    await wait(previous, options.signal)
    return await deploy(options)
  } finally {
    finish()
  }
}

async function deploy(options: ExtensionDeploymentOptions): Promise<PhiExtensionDeployment> {
  const { runtimeHost: host, runtimeRoot: root, bundle } = options
  const prefix = privateRemotePrefix(root)
  const controller = new AbortController()
  const signal = controller.signal
  const cancel = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()
  signal.throwIfAborted()
  const base = posix.join(root, 'extensions')
  const directory = posix.join(base, bundle.contentHash)
  const transaction = randomUUID()
  // Stable paths and upload IDs let the existing transfer manager retain partials
  // across retries. The remote per-hash lock grants exclusive staging ownership.
  const staging = posix.join(base, `.staging-${bundle.contentHash}`)
  const quarantine = posix.join(base, `.replaced-${transaction}`)
  const sourceFiles = [...bundle.files].sort((a, b) => a.path.localeCompare(b.path, 'en'))
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 1,
      contentHash: bundle.contentHash,
      entryPoint: bundle.entryPoint,
      files: sourceFiles.map(({ path, sha256, bytes }) => ({ path, sha256, size: bytes.length }))
    })
  )
  const manifestHash = createHash('sha256').update(manifest).digest('hex')
  const archive = createPhiExtensionArchive(bundle, manifest)
  const archivePath = posix.join(staging, 'bundle.tar')
  const workArchive = posix.join(base, `.archive-${transaction}.tar`)
  const run = async (
    command: string,
    operationSignal: AbortSignal | null | undefined = signal
  ): Promise<string> => {
    operationSignal?.throwIfAborted()
    const result = await host.exec.run(['sh', '-c', `${prefix}\n${command}`], {
      cwd: root,
      signal: operationSignal ?? undefined,
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024
    })
    operationSignal?.throwIfAborted()
    if (result.code !== 0 || result.truncated || result.terminationReason)
      throw new Error(
        `Phi extension deployment failed: ${result.stderr.trim() || result.terminationReason || result.stdout.trim() || result.code}`
      )
    return result.stdout.trim()
  }
  const result = (reused: boolean): PhiExtensionDeployment => ({
    contentHash: bundle.contentHash,
    directory,
    entryPath: posix.join(directory, bundle.entryPoint),
    reused
  })
  let lock: ExtensionLock | undefined
  try {
    options.onProgress?.({ phase: 'checking' })
    await run(`private_dir ${q(base)}`)
    lock = await acquireExtensionLock({
      root,
      contentHash: bundle.contentHash,
      openStdio: options.openLockStdio,
      signal
    })
    void lock.lost.catch((error: unknown) => controller.abort(error))
    await run(`[ ! -L ${q(directory)} ] || fail 'Symbolic extension destination'`)
    if (
      (await run(
        deploymentReadyMarkerCheckCommand(
          deploymentReadyMarkerPath(directory),
          phiExtensionReadyMarkerIdentity(bundle.contentHash),
          'PHI_EXTENSION_VALID'
        )
      )) === 'PHI_EXTENSION_VALID'
    ) {
      options.onProgress?.({ phase: 'ready' })
      return result(true)
    }
    if (!host.transfer) throw new Error('Runtime host has no streaming file transfer transport')
    await run(`private_dir ${q(staging)}`)
    const files = [...sourceFiles, { path: 'manifest.json', bytes: manifest, sha256: manifestHash }]
    for (const file of files) {
      signal?.throwIfAborted()
      await cacheExtensionSnapshot(options.cacheDir, file.bytes, file.sha256, signal)
    }
    const localPath = await cacheExtensionSnapshot(
      options.cacheDir,
      archive.bytes,
      archive.sha256,
      signal
    )
    options.onProgress?.({ phase: 'uploading', file: 'bundle.tar' })
    await host.transfer.uploadFile(localPath, archivePath, {
      ...options.uploadOptions,
      transferId: `phi-ext-${createHash('sha256')
        .update(options.uploadOptions?.hostKey ?? '')
        .update('\0')
        .update(archivePath)
        .update('\0')
        .update(archive.sha256)
        .digest('hex')
        .slice(0, 40)}`,
      reuseVerifiedDestination: true,
      signal,
      expectedSha256: archive.sha256,
      onEvent: (transfer) =>
        options.onProgress?.({ phase: 'uploading', file: 'bundle.tar', transfer })
    })
    signal?.throwIfAborted()
    options.onProgress?.({ phase: 'verifying' })
    if (
      (await run(
        unpackBundleCommand({
          staging,
          archive: archivePath,
          archiveHash: archive.sha256,
          workArchive,
          bundle,
          manifestHash,
          manifestSize: manifest.length
        })
      )) !== 'PHI_EXTENSION_VALID'
    )
      throw new Error('Uploaded Phi extension bundle did not pass complete-file verification')
    await run(
      writeDeploymentReadyMarkerCommand(
        deploymentReadyMarkerPath(staging),
        phiExtensionReadyMarkerIdentity(bundle.contentHash)
      )
    )
    await run(`[ ! -L ${q(directory)} ] || fail 'Symbolic extension destination'
if [ -e ${q(directory)} ]; then owned ${q(directory)}; mv -- ${q(directory)} ${q(quarantine)}; fi
if mv -- ${q(staging)} ${q(directory)}; then rm -rf -- ${q(quarantine)};
else if [ -e ${q(quarantine)} ]; then mv -- ${q(quarantine)} ${q(directory)}; fi; fail 'Cannot publish complete extension bundle'; fi`)
    options.onProgress?.({ phase: 'ready' })
    return result(false)
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    // The server-owned fd releases even if a new exec connection is unavailable.
    // Keep the regular lock file's inode stable for other processes already waiting.
    await lock?.release()
  }
}
