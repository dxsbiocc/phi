import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'

import type {
  RemoteMicromambaArtifact,
  RemoteMicromambaErrorCode,
  RemoteMicromambaProgress
} from '../../../shared/remoteMicromambaTypes'
import type { RemoteMicromambaDownloadCapability } from '../../../shared/remoteRuntimeRootTypes'
import {
  shellQuote,
  type RemoteExecResult,
  type RemoteStdioProcess,
  type RemoteSshSession
} from '../wrappers/remote-ssh-session'
import type { FileTransferCoordinator, TransferEvent } from '../transfer'
import { runRemoteMicromambaScript } from './remote-micromamba-common'
import {
  buildActivateScript,
  buildCleanupScript,
  buildDownloadScript,
  buildFileSizeScript,
  buildHashScript,
  buildNetworkProbeScript,
  parseNetworkProbe,
  parseRemoteFileSize,
  parseRemoteHash
} from './remote-micromamba-shell'

export type RemoteMicromambaArtifactPlan = RemoteMicromambaArtifact & {
  url?: string
  urls?: readonly string[]
}

export interface RemoteMicromambaTransferResult {
  networkProbe?: RemoteMicromambaDownloadCapability
  transferMethod: 'remote-direct' | 'desktop-relay'
}

export class RemoteMicromambaTransferFailure extends Error {
  constructor(
    readonly code: RemoteMicromambaErrorCode,
    message: string,
    readonly networkProbe?: RemoteMicromambaDownloadCapability,
    readonly transferMethod?: RemoteMicromambaTransferResult['transferMethod']
  ) {
    super(message)
  }
}

interface TransferOptions {
  session: RemoteSshSession
  artifact: RemoteMicromambaArtifactPlan
  installPath: string
  obtainLocalArtifact?: () => Promise<RemoteMicromambaArtifact>
  onProgress: (progress: RemoteMicromambaProgress) => void
  signal?: AbortSignal
  randomId?: () => string
  transferCoordinator?: FileTransferCoordinator
  transferHostKey?: string
  transferWorkspaceId?: string
  helperConnect?: () => Promise<RemoteStdioProcess>
  helperVersion?: string
  agentDir?: string
  onTransferEvent?: (event: TransferEvent) => void
}

type DirectSourceOutcome = 'download failed' | 'verification failed'

class DirectDownloadFailure extends Error {
  constructor(readonly outcome: DirectSourceOutcome) {
    super(outcome)
  }
}

interface SourceResult {
  host: string
  outcome: 'unavailable' | 'missing tools' | DirectSourceOutcome
}

const UPLOAD_TIMEOUT_MS = 120_000
const MINIMUM_BYTES_PER_SECOND = 50 * 1024
const MAX_DOWNLOAD_TIMEOUT_MS = 600_000

function downloadTimeoutMs(size: number): number {
  const atMinimumSpeed = Math.ceil((size / MINIMUM_BYTES_PER_SECOND) * 1_000)
  return Math.min(MAX_DOWNLOAD_TIMEOUT_MS, Math.max(60_000, atMinimumSpeed + 30_000))
}

function sourceHost(url: string): string {
  return new URL(url).hostname.toLowerCase()
}

function candidateUrls(artifact: RemoteMicromambaArtifactPlan): readonly string[] {
  const urls = artifact.urls ?? (artifact.url ? [artifact.url] : [])
  return [...new Set(urls)]
}

function sourceResultSummary(results: readonly SourceResult[]): string {
  return results.map(({ host, outcome }) => `${host}: ${outcome}`).join('; ')
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RemoteMicromambaTransferFailure(
      'aborted',
      'Operation cancelled. No further changes were made to the remote runtime.'
    )
  }
}

async function cleanupStaging(session: RemoteSshSession, stagingPath: string): Promise<void> {
  await runRemoteMicromambaScript(session, buildCleanupScript(stagingPath)).catch(() => undefined)
}

export async function readRemoteMicromambaHash(
  session: RemoteSshSession,
  path: string
): Promise<string | undefined> {
  const result = await runRemoteMicromambaScript(session, buildHashScript(path))
  const parsed = parseRemoteHash(result.stdout)
  if (parsed.error === 'missing-tool') {
    throw new RemoteMicromambaTransferFailure(
      'hash-tool-unavailable',
      'The server has none of sha256sum, shasum, openssl, or Perl Digest::SHA, so files cannot be verified.'
    )
  }
  return parsed.hash
}

async function readRemoteFileSize(
  session: RemoteSshSession,
  path: string
): Promise<number | undefined> {
  const result = await runRemoteMicromambaScript(session, buildFileSizeScript(path))
  return result.code === 0 ? parseRemoteFileSize(result.stdout) : undefined
}

async function activateStaging(options: TransferOptions, stagingPath: string): Promise<void> {
  options.onProgress({ stage: 'activating', message: 'Activating the new version atomically…' })
  const activated = await runRemoteMicromambaScript(
    options.session,
    buildActivateScript(stagingPath, options.installPath)
  )
  if (activated.code !== 0) {
    throw new RemoteMicromambaTransferFailure(
      'activation-failed',
      'Unable to activate remote micromamba.'
    )
  }
}

async function probeRemoteNetwork(
  options: TransferOptions,
  url: string
): Promise<RemoteMicromambaDownloadCapability> {
  const host = sourceHost(url)
  options.onProgress({ stage: 'probing-network', message: `Testing download source ${host}…` })
  assertNotAborted(options.signal)
  try {
    const result = await runRemoteMicromambaScript(options.session, buildNetworkProbeScript(url))
    return parseNetworkProbe(result.stdout, host)
  } catch {
    assertNotAborted(options.signal)
    return { status: 'unreachable' }
  }
}

async function runDirectDownload(
  options: TransferOptions,
  script: string
): Promise<RemoteExecResult> {
  if (!options.session.execBounded) {
    return runRemoteMicromambaScript(options.session, script)
  }
  return options.session.execBounded(`sh -c ${shellQuote(script)}`, {
    timeoutMs: downloadTimeoutMs(options.artifact.size),
    maxOutputBytes: 64 * 1024,
    signal: options.signal
  })
}

async function downloadDirectly(
  options: TransferOptions,
  capability: Extract<RemoteMicromambaDownloadCapability, { status: 'reachable' }>,
  url: string
): Promise<void> {
  const host = sourceHost(url)
  const stagingPath = `${options.installPath}.download-${(options.randomId ?? randomUUID)()}`
  try {
    options.onProgress({
      stage: 'remote-downloading',
      message: `Downloading micromamba from ${host} on the server…`
    })
    assertNotAborted(options.signal)
    try {
      const timeoutMs = downloadTimeoutMs(options.artifact.size)
      const downloaded = await runDirectDownload(
        options,
        buildDownloadScript(url, stagingPath, capability.tool, Math.ceil(timeoutMs / 1_000))
      )
      if (downloaded.code !== 0) throw new DirectDownloadFailure('download failed')
    } catch {
      assertNotAborted(options.signal)
      throw new DirectDownloadFailure('download failed')
    }
    assertNotAborted(options.signal)
    options.onProgress({
      stage: 'verifying-upload',
      message: `Verifying the file downloaded from ${host}…`
    })
    const hash = await readRemoteMicromambaHash(options.session, stagingPath)
    const size = await readRemoteFileSize(options.session, stagingPath)
    if (hash !== options.artifact.sha256 || size !== options.artifact.size) {
      throw new DirectDownloadFailure('verification failed')
    }
    await activateStaging(options, stagingPath)
  } catch (error) {
    await cleanupStaging(options.session, stagingPath)
    throw error
  }
}

function sameArtifact(
  expected: RemoteMicromambaArtifactPlan,
  candidate: RemoteMicromambaArtifact
): boolean {
  return (
    expected.version === candidate.version &&
    expected.platform === candidate.platform &&
    expected.sha256 === candidate.sha256 &&
    expected.size === candidate.size
  )
}

async function obtainRelayArtifact(options: TransferOptions): Promise<RemoteMicromambaArtifact> {
  let artifact: RemoteMicromambaArtifact
  try {
    artifact = options.obtainLocalArtifact ? await options.obtainLocalArtifact() : options.artifact
  } catch {
    throw new RemoteMicromambaTransferFailure(
      'upload-failed',
      'Unable to prepare the desktop relay file.'
    )
  }
  if (!sameArtifact(options.artifact, artifact)) {
    throw new RemoteMicromambaTransferFailure(
      'invalid-artifact',
      'Invalid desktop relay file metadata.'
    )
  }
  return artifact
}

async function uploadAttempt(
  options: TransferOptions,
  localPath: string,
  attempt: number,
  stagingPath: string,
  transferId: string
): Promise<void> {
  try {
    options.onProgress({
      stage: 'uploading',
      message: 'Uploading micromamba…',
      attempt,
      transferredBytes: 0,
      totalBytes: options.artifact.size
    })
    assertNotAborted(options.signal)
    const remoteRoot = posix.dirname(options.installPath)
    await options.session.uploadFile(localPath, stagingPath, {
      timeoutMs: UPLOAD_TIMEOUT_MS,
      transferId,
      expectedSha256: options.artifact.sha256,
      remoteRoot,
      canonicalRoot: remoteRoot,
      hostKey: options.transferHostKey ?? `micromamba-${transferId.slice(-24)}`,
      workspaceId:
        options.transferWorkspaceId ?? createHash('sha256').update(remoteRoot).digest('hex'),
      signal: options.signal,
      coordinator: options.transferCoordinator,
      helperConnect: options.helperConnect,
      helperVersion: options.helperVersion,
      agentDir: options.agentDir,
      reuseVerifiedDestination: true,
      onEvent: (event) => {
        options.onTransferEvent?.(event)
        if (event.state === 'transferring' && event.bytesTransferred > 0) {
          options.onProgress({
            stage: 'uploading',
            message: 'Uploading micromamba…',
            attempt,
            transferredBytes: event.bytesTransferred,
            totalBytes: event.totalBytes ?? options.artifact.size
          })
        }
      }
    })
    options.onProgress({
      stage: 'uploading',
      message: 'micromamba upload complete.',
      attempt,
      transferredBytes: options.artifact.size,
      totalBytes: options.artifact.size
    })
    assertNotAborted(options.signal)
    options.onProgress({
      stage: 'verifying-upload',
      message: 'Verifying the uploaded file…',
      attempt
    })
    const hash = await readRemoteMicromambaHash(options.session, stagingPath)
    if (hash !== options.artifact.sha256) {
      throw new RemoteMicromambaTransferFailure(
        'remote-hash-mismatch',
        'The uploaded file SHA-256 does not match.'
      )
    }
    await activateStaging(options, stagingPath)
  } catch (error) {
    await cleanupStaging(options.session, stagingPath)
    if (error instanceof RemoteMicromambaTransferFailure) throw error
    throw new RemoteMicromambaTransferFailure('upload-failed', 'micromamba upload failed.')
  }
}

async function uploadWithRetry(options: TransferOptions, localPath: string): Promise<void> {
  const identity = createHash('sha256')
    .update(options.transferHostKey ?? 'unscoped-host')
    .update('\0')
    .update(options.installPath)
    .update('\0')
    .update(options.artifact.sha256)
    .digest('hex')
  const stagingPath = `${options.installPath}.upload-${identity.slice(0, 24)}`
  const transferId = `micromamba-${identity.slice(0, 40)}`
  let failure: RemoteMicromambaTransferFailure | undefined
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await uploadAttempt(options, localPath, attempt, stagingPath, transferId)
      return
    } catch (error) {
      failure =
        error instanceof RemoteMicromambaTransferFailure
          ? error
          : new RemoteMicromambaTransferFailure('upload-failed', 'micromamba upload failed.')
      if (failure.code === 'aborted' || failure.code === 'hash-tool-unavailable') throw failure
    }
  }
  throw failure ?? new RemoteMicromambaTransferFailure('upload-failed', 'micromamba upload failed.')
}

function relayMessage(capability?: RemoteMicromambaDownloadCapability): string {
  if (capability?.status === 'unreachable')
    return 'The server cannot reach the release URL. Using desktop relay…'
  if (capability?.status === 'no-tool')
    return 'curl/wget is missing on the server. Using desktop relay…'
  return 'Relaying micromamba through the desktop…'
}

async function relayFromDesktop(
  options: TransferOptions,
  capability?: RemoteMicromambaDownloadCapability,
  message = relayMessage(capability)
): Promise<RemoteMicromambaTransferResult> {
  options.onProgress({ stage: 'desktop-relay', message })
  try {
    const artifact = await obtainRelayArtifact(options)
    await uploadWithRetry(options, artifact.localPath)
    return { networkProbe: capability, transferMethod: 'desktop-relay' }
  } catch (error) {
    const failure =
      error instanceof RemoteMicromambaTransferFailure
        ? error
        : new RemoteMicromambaTransferFailure('upload-failed', 'micromamba upload failed.')
    throw new RemoteMicromambaTransferFailure(
      failure.code,
      failure.message,
      capability,
      'desktop-relay'
    )
  }
}

function terminalDirectFailure(
  error: unknown,
  capability: RemoteMicromambaDownloadCapability
): RemoteMicromambaTransferFailure {
  const failure =
    error instanceof RemoteMicromambaTransferFailure
      ? error
      : new RemoteMicromambaTransferFailure(
          'upload-failed',
          'Direct download on the server failed.'
        )
  return new RemoteMicromambaTransferFailure(
    failure.code,
    failure.message,
    capability,
    'remote-direct'
  )
}

function exhaustedCapability(
  missingTool: boolean,
  toolDetected: boolean
): RemoteMicromambaDownloadCapability {
  return { status: missingTool && !toolDetected ? 'no-tool' : 'unreachable' }
}

export async function transferRemoteMicromamba(
  options: TransferOptions
): Promise<RemoteMicromambaTransferResult> {
  const urls = candidateUrls(options.artifact)
  if (urls.length === 0) return relayFromDesktop(options)
  const results: SourceResult[] = []
  let missingTool = false
  let toolDetected = false
  for (const url of urls) {
    const host = sourceHost(url)
    const capability = await probeRemoteNetwork(options, url)
    toolDetected ||= capability.status !== 'no-tool'
    if (capability.status !== 'reachable') {
      missingTool ||= capability.status === 'no-tool'
      results.push({
        host,
        outcome: capability.status === 'no-tool' ? 'missing tools' : 'unavailable'
      })
      if (capability.status === 'no-tool') break
      continue
    }
    options.onProgress({
      stage: 'probing-network',
      message: `Download source ${host} is available.`
    })
    try {
      await downloadDirectly(options, capability, url)
      return { networkProbe: capability, transferMethod: 'remote-direct' }
    } catch (error) {
      if (!(error instanceof DirectDownloadFailure)) throw terminalDirectFailure(error, capability)
      results.push({ host, outcome: error.outcome })
      options.onProgress({
        stage: 'probing-network',
        message: `${host}: ${error.outcome}. Trying the next download source…`
      })
    }
  }
  const capability = exhaustedCapability(missingTool, toolDetected)
  const summary = sourceResultSummary(results)
  return relayFromDesktop(
    options,
    capability,
    `Download source results: ${summary}. Using desktop relay…`
  )
}
