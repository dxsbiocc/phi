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
}

type DirectSourceOutcome = '下载失败' | '校验失败'

class DirectDownloadFailure extends Error {
  constructor(readonly outcome: DirectSourceOutcome) {
    super(outcome)
  }
}

interface SourceResult {
  host: string
  outcome: '不可用' | '缺少工具' | DirectSourceOutcome
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
  return results.map(({ host, outcome }) => `${host}：${outcome}`).join('；')
}

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
  const host = sourceHost(url)
  options.onProgress({ stage: 'probing-network', message: `正在测速下载源 ${host}…` })
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
      message: `正在由服务器从 ${host} 下载 micromamba…`
    })
    assertNotAborted(options.signal)
    try {
      const timeoutMs = downloadTimeoutMs(options.artifact.size)
      const downloaded = await runDirectDownload(
        options,
        buildDownloadScript(url, stagingPath, capability.tool, Math.ceil(timeoutMs / 1_000))
      )
      if (downloaded.code !== 0) throw new DirectDownloadFailure('下载失败')
    } catch {
      assertNotAborted(options.signal)
      throw new DirectDownloadFailure('下载失败')
    }
    assertNotAborted(options.signal)
    options.onProgress({ stage: 'verifying-upload', message: `正在校验 ${host} 下载的文件…` })
    const hash = await readRemoteMicromambaHash(options.session, stagingPath)
    const size = await readRemoteFileSize(options.session, stagingPath)
    if (hash !== options.artifact.sha256 || size !== options.artifact.size) {
      throw new DirectDownloadFailure('校验失败')
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

function terminalDirectFailure(
  error: unknown,
  capability: RemoteMicromambaDownloadCapability
): RemoteMicromambaTransferFailure {
  const failure =
    error instanceof RemoteMicromambaTransferFailure
      ? error
      : new RemoteMicromambaTransferFailure('upload-failed', '服务器直连下载失败。')
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
      results.push({ host, outcome: capability.status === 'no-tool' ? '缺少工具' : '不可用' })
      if (capability.status === 'no-tool') break
      continue
    }
    options.onProgress({ stage: 'probing-network', message: `下载源 ${host} 可用。` })
    try {
      await downloadDirectly(options, capability, url)
      return { networkProbe: capability, transferMethod: 'remote-direct' }
    } catch (error) {
      if (!(error instanceof DirectDownloadFailure)) throw terminalDirectFailure(error, capability)
      results.push({ host, outcome: error.outcome })
      options.onProgress({
        stage: 'probing-network',
        message: `${host} ${error.outcome}，尝试下一下载源…`
      })
    }
  }
  const capability = exhaustedCapability(missingTool, toolDetected)
  const summary = sourceResultSummary(results)
  return relayFromDesktop(options, capability, `下载源结果：${summary}。正在使用本机中转…`)
}
