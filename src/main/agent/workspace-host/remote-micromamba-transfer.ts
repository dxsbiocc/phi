import { randomUUID } from 'node:crypto'

import type {
  RemoteMicromambaArtifact,
  RemoteMicromambaErrorCode,
  RemoteMicromambaProgress
} from '../../../shared/remoteMicromambaTypes'
import type { RemoteMicromambaDownloadCapability } from '../../../shared/remoteRuntimeRootTypes'
import {
  shellQuote,
  type RemoteExecResult,
  type RemoteSshSession
} from '../wrappers/remote-ssh-session'
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

export type RemoteMicromambaArtifactPlan = RemoteMicromambaArtifact & { url?: string }

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
}

class DirectDownloadFailure extends Error {}

const UPLOAD_TIMEOUT_MS = 120_000
const DIRECT_DOWNLOAD_TIMEOUT_MS = 310_000

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RemoteMicromambaTransferFailure('aborted', '操作已取消，未继续修改远端运行时。')
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
      '服务器缺少 sha256sum、shasum、openssl 或 Perl Digest::SHA，无法校验文件。'
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
  options.onProgress({ stage: 'activating', message: '正在原子激活新版本…' })
  const activated = await runRemoteMicromambaScript(
    options.session,
    buildActivateScript(stagingPath, options.installPath)
  )
  if (activated.code !== 0) {
    throw new RemoteMicromambaTransferFailure('activation-failed', '无法激活远端 micromamba。')
  }
}

async function probeRemoteNetwork(
  options: TransferOptions,
  url: string
): Promise<RemoteMicromambaDownloadCapability> {
  options.onProgress({ stage: 'probing-network', message: '正在探测服务器直连下载能力…' })
  assertNotAborted(options.signal)
  try {
    const result = await runRemoteMicromambaScript(options.session, buildNetworkProbeScript(url))
    return parseNetworkProbe(result.stdout)
  } catch {
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
    timeoutMs: DIRECT_DOWNLOAD_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    signal: options.signal
  })
}

async function downloadDirectly(
  options: TransferOptions,
  capability: Extract<RemoteMicromambaDownloadCapability, { status: 'reachable' }>,
  url: string
): Promise<void> {
  const stagingPath = `${options.installPath}.download-${(options.randomId ?? randomUUID)()}`
  try {
    options.onProgress({
      stage: 'remote-downloading',
      message: `正在由服务器使用 ${capability.tool} 直连下载 micromamba…`
    })
    assertNotAborted(options.signal)
    try {
      const downloaded = await runDirectDownload(
        options,
        buildDownloadScript(url, stagingPath, capability.tool)
      )
      if (downloaded.code !== 0) throw new DirectDownloadFailure()
    } catch {
      assertNotAborted(options.signal)
      throw new DirectDownloadFailure()
    }
    assertNotAborted(options.signal)
    options.onProgress({ stage: 'verifying-upload', message: '正在校验直连下载文件…' })
    const hash = await readRemoteMicromambaHash(options.session, stagingPath)
    const size = await readRemoteFileSize(options.session, stagingPath)
    if (hash !== options.artifact.sha256 || size !== options.artifact.size) {
      throw new RemoteMicromambaTransferFailure(
        'remote-hash-mismatch',
        '服务器直连下载文件的 SHA-256 或大小不匹配。'
      )
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
    throw new RemoteMicromambaTransferFailure('upload-failed', '准备本机中转文件失败。')
  }
  if (!sameArtifact(options.artifact, artifact)) {
    throw new RemoteMicromambaTransferFailure('invalid-artifact', '本机中转文件信息无效。')
  }
  return artifact
}

async function uploadAttempt(
  options: TransferOptions,
  localPath: string,
  attempt: number
): Promise<void> {
  const stagingPath = `${options.installPath}.upload-${(options.randomId ?? randomUUID)()}`
  try {
    options.onProgress({
      stage: 'uploading',
      message: '正在上传 micromamba…',
      attempt,
      transferredBytes: 0,
      totalBytes: options.artifact.size
    })
    assertNotAborted(options.signal)
    await options.session.uploadFile(localPath, stagingPath, { timeoutMs: UPLOAD_TIMEOUT_MS })
    options.onProgress({
      stage: 'uploading',
      message: 'micromamba 上传完成。',
      attempt,
      transferredBytes: options.artifact.size,
      totalBytes: options.artifact.size
    })
    assertNotAborted(options.signal)
    options.onProgress({
      stage: 'verifying-upload',
      message: '正在校验上传文件…',
      attempt
    })
    const hash = await readRemoteMicromambaHash(options.session, stagingPath)
    if (hash !== options.artifact.sha256) {
      throw new RemoteMicromambaTransferFailure(
        'remote-hash-mismatch',
        '上传文件的 SHA-256 不匹配。'
      )
    }
    await activateStaging(options, stagingPath)
  } catch (error) {
    await cleanupStaging(options.session, stagingPath)
    if (error instanceof RemoteMicromambaTransferFailure) throw error
    throw new RemoteMicromambaTransferFailure('upload-failed', '上传 micromamba 失败。')
  }
}

async function uploadWithRetry(options: TransferOptions, localPath: string): Promise<void> {
  let failure: RemoteMicromambaTransferFailure | undefined
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await uploadAttempt(options, localPath, attempt)
      return
    } catch (error) {
      failure =
        error instanceof RemoteMicromambaTransferFailure
          ? error
          : new RemoteMicromambaTransferFailure('upload-failed', '上传 micromamba 失败。')
      if (failure.code === 'aborted' || failure.code === 'hash-tool-unavailable') throw failure
    }
  }
  throw failure ?? new RemoteMicromambaTransferFailure('upload-failed', '上传 micromamba 失败。')
}

function relayMessage(capability?: RemoteMicromambaDownloadCapability): string {
  if (capability?.status === 'unreachable') return '服务器无法直连发布地址，正在使用本机中转…'
  if (capability?.status === 'no-tool') return '服务器缺少 curl/wget，正在使用本机中转…'
  return '正在使用本机中转 micromamba…'
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
        : new RemoteMicromambaTransferFailure('upload-failed', '上传 micromamba 失败。')
    throw new RemoteMicromambaTransferFailure(
      failure.code,
      failure.message,
      capability,
      'desktop-relay'
    )
  }
}

export async function transferRemoteMicromamba(
  options: TransferOptions
): Promise<RemoteMicromambaTransferResult> {
  const url = options.artifact.url
  if (!url) return relayFromDesktop(options)
  const capability = await probeRemoteNetwork(options, url)
  if (capability.status !== 'reachable') return relayFromDesktop(options, capability)
  try {
    await downloadDirectly(options, capability, url)
    return { networkProbe: capability, transferMethod: 'remote-direct' }
  } catch (error) {
    if (error instanceof DirectDownloadFailure) {
      return relayFromDesktop(options, capability, '直连下载失败，正在改用本机中转…')
    }
    const failure =
      error instanceof RemoteMicromambaTransferFailure
        ? error
        : new RemoteMicromambaTransferFailure('upload-failed', '服务器直连下载失败。')
    throw new RemoteMicromambaTransferFailure(
      failure.code,
      failure.message,
      capability,
      'remote-direct'
    )
  }
}
