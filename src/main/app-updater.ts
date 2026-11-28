import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import type {
  AppUpdateAsset,
  AppUpdateCheck,
  AppUpdateDownloadState
} from '../shared/appUpdateTypes'
import { errorMessage } from '../shared/errorCodes'
import {
  checkForAppUpdate,
  RELEASE_DOWNLOAD_PREFIX,
  type AppUpdatePlatformContext
} from './app-update-check'

const PROGRESS_THROTTLE_MS = 80
const CHECKSUM_TIMEOUT_MS = 15_000

const IDLE_DOWNLOAD_STATE: AppUpdateDownloadState = {
  stage: 'idle',
  downloadedBytes: 0,
  totalBytes: 0,
  percent: null
}

export interface AppUpdateManagerOptions extends AppUpdatePlatformContext {
  updatesDir: string
  getVersion: () => string
  fetchImpl: typeof globalThis.fetch
  openPath: (filePath: string) => Promise<string>
  quitApp: () => void
  onWillQuit: (listener: () => void) => void
  spawnDetached?: (command: string, args: string[]) => void
  scheduleQuit?: (run: () => void) => void
  onStateChange?: (state: AppUpdateDownloadState) => void
}

export interface AppUpdateManager {
  check: () => Promise<AppUpdateCheck>
  getState: () => AppUpdateDownloadState
  download: () => Promise<AppUpdateDownloadState>
  cancelDownload: () => AppUpdateDownloadState
  install: () => Promise<void>
}

export function parseSha256Sums(content: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line)
    if (!match) continue
    const hash = match[1].toLowerCase()
    const fileName = path.posix.basename(match[2].trim().replace(/\\/g, '/'))
    if (fileName) map.set(fileName, hash)
  }
  return map
}

async function computeFileSha256(filePath: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let size = 0
    const stream = createReadStream(filePath)
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buf.byteLength
      hash.update(buf)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve({ sha256: hash.digest('hex').toLowerCase(), size }))
  })
}

function defaultSpawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
}

async function writeChunkWithBackpressure(stream: WriteStream, chunk: Buffer): Promise<void> {
  if (stream.write(chunk)) return
  await new Promise<void>((resolve, reject) => {
    stream.once('drain', resolve)
    stream.once('error', reject)
  })
}

async function closeWriteStream(stream: WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()))
  })
}

async function fetchChecksumForAsset(
  fetchImpl: typeof globalThis.fetch,
  userAgent: string,
  asset: AppUpdateAsset,
  signal: AbortSignal
): Promise<string> {
  if (!asset.checksumUrl || !asset.checksumUrl.startsWith(RELEASE_DOWNLOAD_PREFIX)) {
    throw new Error('缺少官方 SHA256SUMS.txt 校验文件，已拒绝未校验安装包')
  }
  const timeoutController = new AbortController()
  const onOuterAbort = (): void => timeoutController.abort()
  signal.addEventListener('abort', onOuterAbort, { once: true })
  const timer = setTimeout(() => timeoutController.abort(), CHECKSUM_TIMEOUT_MS)
  try {
    const response = await fetchImpl(asset.checksumUrl, {
      headers: { 'User-Agent': userAgent },
      signal: timeoutController.signal
    })
    if (!response.ok) throw new Error(`获取校验文件失败（HTTP ${response.status}）`)
    const expected = parseSha256Sums(await response.text()).get(asset.name)
    if (!expected) throw new Error(`SHA256SUMS.txt 中未找到 ${asset.name} 的校验值`)
    return expected
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onOuterAbort)
  }
}

async function streamDownloadToPartFile(input: {
  response: Response
  partPath: string
  fallbackTotalBytes: number
  onProgress: (downloadedBytes: number, totalBytes: number, percent: number | null) => void
}): Promise<{ sha256: string; downloadedBytes: number; totalBytes: number }> {
  if (!input.response.body) throw new Error('下载流不可用')
  const contentLength = Number(input.response.headers.get('content-length') ?? 0)
  const totalBytes =
    Number.isFinite(contentLength) && contentLength > 0 ? contentLength : input.fallbackTotalBytes
  const hash = createHash('sha256')
  const fileStream = createWriteStream(input.partPath)
  const reader = input.response.body.getReader()
  let downloadedBytes = 0
  let lastEmitAt = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      downloadedBytes += chunk.byteLength
      hash.update(chunk)
      await writeChunkWithBackpressure(fileStream, chunk)
      const nowMs = Date.now()
      if (nowMs - lastEmitAt >= PROGRESS_THROTTLE_MS) {
        lastEmitAt = nowMs
        const percent =
          totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : null
        input.onProgress(downloadedBytes, totalBytes, percent)
      }
    }
    await closeWriteStream(fileStream)
    return {
      sha256: hash.digest('hex').toLowerCase(),
      downloadedBytes,
      totalBytes: totalBytes || downloadedBytes
    }
  } catch (error) {
    fileStream.destroy()
    await reader.cancel().catch(() => undefined)
    throw error
  }
}

async function pruneSiblingVersionDirs(updatesDir: string, keepVersion: string): Promise<void> {
  try {
    const entries = await readdir(updatesDir, { withFileTypes: true })
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name !== keepVersion)
        .map((entry) => rm(path.join(updatesDir, entry.name), { recursive: true, force: true }))
    )
  } catch {
    // Best-effort cache cleanup never fails the active update.
  }
}

async function tryReuseCachedInstaller(input: {
  finalPath: string
  version: string
  asset: AppUpdateAsset
  targetSha256: string
  setState: (next: AppUpdateDownloadState) => AppUpdateDownloadState
}): Promise<AppUpdateDownloadState | null> {
  const existingStat = await stat(input.finalPath).catch(() => null)
  if (!existingStat?.isFile()) return null
  input.setState({
    stage: 'verifying',
    version: input.version,
    assetName: input.asset.name,
    installMode: input.asset.installMode,
    downloadedBytes: existingStat.size,
    totalBytes: existingStat.size,
    percent: 100
  })
  const existing = await computeFileSha256(input.finalPath)
  if (existing.sha256 !== input.targetSha256) {
    await rm(input.finalPath, { force: true })
    return null
  }
  return input.setState({
    stage: 'downloaded',
    version: input.version,
    assetName: input.asset.name,
    installMode: input.asset.installMode,
    downloadedBytes: existing.size,
    totalBytes: existing.size,
    percent: 100,
    downloadedPath: input.finalPath,
    sha256: existing.sha256
  })
}

async function executeVerifiedInstall(input: {
  targetPath: string
  targetMode: AppUpdateAsset['installMode']
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  registerQuitHookOnce: (hook: () => void) => void
  spawnDetached: (command: string, args: string[]) => void
  openPath: (filePath: string) => Promise<string>
  scheduleQuit: (run: () => void) => void
  quitApp: () => void
}): Promise<void> {
  if (input.targetMode === 'auto-replace' && input.platform === 'win32') {
    input.registerQuitHookOnce(() => {
      input.spawnDetached(input.targetPath, ['--updated', '--force-run', '/S'])
    })
    input.scheduleQuit(input.quitApp)
    return
  }

  if (input.targetMode === 'auto-replace' && input.platform === 'linux') {
    const appImagePath = input.env.APPIMAGE?.trim()
    if (!appImagePath) throw new Error('未检测到运行中的 AppImage 路径')
    const stagingPath = `${appImagePath}.phi-update-${process.pid}`
    await copyFile(input.targetPath, stagingPath)
    await chmod(stagingPath, 0o755)
    await rename(stagingPath, appImagePath)
    input.registerQuitHookOnce(() => {
      input.spawnDetached(appImagePath, [])
    })
    input.scheduleQuit(input.quitApp)
    return
  }

  const openError = await input.openPath(input.targetPath)
  if (openError.trim().length > 0) throw new Error(openError)
  input.scheduleQuit(input.quitApp)
}

interface ManagerRuntime {
  options: AppUpdateManagerOptions
  platform: NodeJS.Platform
  arch: string
  env: NodeJS.ProcessEnv
  spawnDetached: (command: string, args: string[]) => void
  scheduleQuit: (run: () => void) => void
  state: AppUpdateDownloadState
  latestCheck: AppUpdateCheck | null
  expectedSha256: string | null
  activeAbort: AbortController | null
  inFlightDownload: Promise<AppUpdateDownloadState> | null
  installQuitRegistered: boolean
  setState: (next: AppUpdateDownloadState) => AppUpdateDownloadState
}

async function performAssetDownload(
  rt: ManagerRuntime,
  version: string,
  asset: AppUpdateAsset
): Promise<AppUpdateDownloadState> {
  if (!asset.downloadUrl.startsWith(RELEASE_DOWNLOAD_PREFIX)) {
    throw new Error('更新包下载地址不受信任')
  }
  const controller = new AbortController()
  rt.activeAbort = controller
  const versionDir = path.join(rt.options.updatesDir, version)
  const finalPath = path.join(versionDir, asset.name)
  const partPath = `${finalPath}.part`
  const userAgent = `Phi/${rt.options.getVersion()}`

  rt.setState({
    stage: 'downloading',
    version,
    assetName: asset.name,
    installMode: asset.installMode,
    downloadedBytes: 0,
    totalBytes: asset.size,
    percent: asset.size > 0 ? 0 : null
  })

  try {
    await mkdir(versionDir, { recursive: true })
    const targetSha256 = await fetchChecksumForAsset(
      rt.options.fetchImpl,
      userAgent,
      asset,
      controller.signal
    )
    const reused = await tryReuseCachedInstaller({
      finalPath,
      version,
      asset,
      targetSha256,
      setState: rt.setState
    })
    if (reused) {
      rt.expectedSha256 = targetSha256
      void pruneSiblingVersionDirs(rt.options.updatesDir, version)
      return reused
    }

    await rm(partPath, { force: true })
    const response = await rt.options.fetchImpl(asset.downloadUrl, {
      headers: { 'User-Agent': userAgent },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`下载安装包失败（HTTP ${response.status}）`)

    const streamed = await streamDownloadToPartFile({
      response,
      partPath,
      fallbackTotalBytes: asset.size,
      onProgress: (downloadedBytes, totalBytes, percent) => {
        rt.setState({
          stage: 'downloading',
          version,
          assetName: asset.name,
          installMode: asset.installMode,
          downloadedBytes,
          totalBytes,
          percent
        })
      }
    })

    rt.setState({
      stage: 'verifying',
      version,
      assetName: asset.name,
      installMode: asset.installMode,
      downloadedBytes: streamed.downloadedBytes,
      totalBytes: streamed.totalBytes,
      percent: 100
    })

    if (streamed.sha256 !== targetSha256) {
      await rm(partPath, { force: true })
      throw new Error('安装包 SHA-256 校验失败，已丢弃损坏文件')
    }

    await rename(partPath, finalPath)
    rt.expectedSha256 = targetSha256
    void pruneSiblingVersionDirs(rt.options.updatesDir, version)
    return rt.setState({
      stage: 'downloaded',
      version,
      assetName: asset.name,
      installMode: asset.installMode,
      downloadedBytes: streamed.downloadedBytes,
      totalBytes: streamed.totalBytes,
      percent: 100,
      downloadedPath: finalPath,
      sha256: streamed.sha256
    })
  } catch (error) {
    await rm(partPath, { force: true }).catch(() => undefined)
    if (controller.signal.aborted) return rt.setState({ ...IDLE_DOWNLOAD_STATE })
    return rt.setState({
      stage: 'error',
      version,
      assetName: asset.name,
      installMode: asset.installMode,
      downloadedBytes: rt.state.downloadedBytes,
      totalBytes: rt.state.totalBytes,
      percent: rt.state.percent,
      error: errorMessage(error)
    })
  } finally {
    if (rt.activeAbort === controller) rt.activeAbort = null
  }
}

async function performInstall(rt: ManagerRuntime): Promise<void> {
  if (rt.state.stage !== 'downloaded' || !rt.state.downloadedPath || !rt.expectedSha256) {
    throw new Error('更新安装包尚未准备就绪')
  }
  const targetPath = rt.state.downloadedPath
  const targetMode = rt.state.installMode ?? 'open-installer'
  const snapshot = { ...rt.state }
  rt.setState({ ...snapshot, stage: 'installing' })

  try {
    const verified = await computeFileSha256(targetPath)
    if (verified.sha256 !== rt.expectedSha256) {
      await rm(targetPath, { force: true }).catch(() => undefined)
      rt.expectedSha256 = null
      throw new Error('安装前校验未通过，请重新下载更新包')
    }
    await executeVerifiedInstall({
      targetPath,
      targetMode,
      platform: rt.platform,
      env: rt.env,
      registerQuitHookOnce: (hook) => {
        if (rt.installQuitRegistered) return
        rt.installQuitRegistered = true
        rt.options.onWillQuit(hook)
      },
      spawnDetached: rt.spawnDetached,
      openPath: rt.options.openPath,
      scheduleQuit: rt.scheduleQuit,
      quitApp: rt.options.quitApp
    })
  } catch (error) {
    rt.setState({ ...snapshot, stage: 'error', error: errorMessage(error) })
    throw error
  }
}

export function createAppUpdateManager(options: AppUpdateManagerOptions): AppUpdateManager {
  const rt: ManagerRuntime = {
    options,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    env: options.env ?? process.env,
    spawnDetached: options.spawnDetached ?? defaultSpawnDetached,
    scheduleQuit: options.scheduleQuit ?? ((run: () => void) => void setImmediate(run)),
    state: { ...IDLE_DOWNLOAD_STATE },
    latestCheck: null,
    expectedSha256: null,
    activeAbort: null,
    inFlightDownload: null,
    installQuitRegistered: false,
    setState: (next) => {
      rt.state = next
      options.onStateChange?.(rt.state)
      return rt.state
    }
  }

  const check = async (): Promise<AppUpdateCheck> => {
    const result = await checkForAppUpdate(options.getVersion(), options.fetchImpl, undefined, {
      platform: rt.platform,
      arch: rt.arch,
      env: rt.env
    })
    rt.latestCheck = result
    const staleVersion =
      Boolean(rt.state.version) &&
      rt.state.version !== result.latestVersion &&
      rt.state.stage !== 'downloading'
    if (result.status !== 'available' || !result.latestVersion || staleVersion) {
      rt.expectedSha256 = null
      rt.setState({ ...IDLE_DOWNLOAD_STATE })
    }
    return result
  }

  const download = async (): Promise<AppUpdateDownloadState> => {
    if (rt.inFlightDownload) return rt.inFlightDownload
    const resolved = rt.latestCheck ?? (await check())
    if (resolved.status !== 'available' || !resolved.latestVersion || !resolved.asset) {
      return rt.setState({
        stage: 'error',
        version: resolved.latestVersion,
        downloadedBytes: 0,
        totalBytes: 0,
        percent: null,
        error: resolved.error ?? '当前平台暂无可直接下载的安装包，请前往发布页手动下载'
      })
    }
    if (
      rt.state.stage === 'downloaded' &&
      rt.state.version === resolved.latestVersion &&
      rt.state.downloadedPath &&
      rt.expectedSha256
    ) {
      const existing = await stat(rt.state.downloadedPath).catch(() => null)
      if (existing?.isFile()) return rt.state
    }
    const { latestVersion, asset } = resolved
    rt.inFlightDownload = performAssetDownload(rt, latestVersion, asset).finally(() => {
      rt.inFlightDownload = null
    })
    return rt.inFlightDownload
  }

  return {
    check,
    getState: () => rt.state,
    download,
    cancelDownload: () => {
      rt.activeAbort?.abort()
      rt.activeAbort = null
      return rt.setState({ ...IDLE_DOWNLOAD_STATE })
    },
    install: () => performInstall(rt)
  }
}
