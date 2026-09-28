import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { RemoteSshSession } from '../remote-ssh-session'
import { shellQuote } from '../remote-ssh-session'

/**
 * Puts a wrapper's Singularity images into the cluster's cache before a run.
 *
 * Nextflow pulls each image on first use, from wherever the head job runs —
 * which on many clusters is a compute node with no internet (the yzhang
 * cluster: every pull failed). Phi fills the gap: it works out which images a
 * wrapper needs, has the login node download the missing ones, and when the
 * login node cannot reach the registry either, downloads them on this machine
 * and uploads them. Nextflow then finds them in its cache and never pulls.
 */

export interface WrapperContainerImage {
  /** The Singularity image URL from the module's `container` directive. */
  url: string
  /** The file name Nextflow looks for in `singularity.cacheDir`. */
  fileName: string
}

export interface StageImagesResult {
  /** Images that were missing and are now in the cache. */
  staged: string[]
  /** Images that are still missing, with why. */
  failed: Array<{ fileName: string; reason: string }>
}

export interface StageImagesOptions {
  images: WrapperContainerImage[]
  cacheDir: string
  onOutput?: (line: string) => void
  /** Downloads `url` to the local file `target`. Defaults to an HTTP download on this machine. */
  downloadLocally?: (url: string, target: string) => Promise<void>
  /** Per-image limit for the login node's own download. Default 30 minutes. */
  remoteTimeoutMs?: number
  /** Per-image limit for uploading from this machine. Default 60 minutes. */
  uploadTimeoutMs?: number
}

const INCLUDE = /include\s*\{[\s\S]*?\}\s*from\s*['"]([^'"]+)['"]/g
const CONTAINER = /^\s*container\s+(['"])([\s\S]*?)\1/gm
const IMAGE_URL = /https:\/\/[^'"\s}]+/
const DEFAULT_REMOTE_TIMEOUT_MS = 30 * 60_000
const DEFAULT_UPLOAD_TIMEOUT_MS = 60 * 60_000
const MAX_COMMAND_OUTPUT = 64 * 1024

/** Nextflow's own cache naming (SingularityCache.simpleName). */
export function singularityCacheFileName(url: string): string {
  const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const name = withoutScheme.replace(/[:/]/g, '-')
  return name.endsWith('.img') || name.endsWith('.sif') ? name : `${name}.img`
}

function resolveInclude(fromFile: string, target: string): string | undefined {
  const base = resolve(dirname(fromFile), target)
  for (const candidate of [base, `${base}.nf`, join(base, 'main.nf')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

/**
 * Every Singularity image URL reachable from a wrapper's `main.nf`, following
 * `include` statements. Containers named only by a Docker tag (no https URL)
 * are skipped: Nextflow builds those itself and there is no file to stage.
 */
export function collectWrapperSingularityImages(wrapperMainNf: string): WrapperContainerImage[] {
  const seenFiles = new Set<string>()
  const urls = new Set<string>()
  const visit = (file: string): void => {
    if (seenFiles.has(file)) return
    seenFiles.add(file)
    const text = readFileSync(file, 'utf-8')
    for (const match of text.matchAll(CONTAINER)) {
      const url = IMAGE_URL.exec(match[2])?.[0]
      if (url) urls.add(url)
    }
    for (const match of text.matchAll(INCLUDE)) {
      const included = resolveInclude(file, match[1])
      if (included) visit(included)
    }
  }
  visit(resolve(wrapperMainNf))
  return [...urls].sort().map((url) => ({ url, fileName: singularityCacheFileName(url) }))
}

async function downloadOverHttp(url: string, target: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_UPLOAD_TIMEOUT_MS) })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target))
}

function run(
  session: RemoteSshSession,
  command: string,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return session.execBounded
    ? session.execBounded(command, { timeoutMs, maxOutputBytes: MAX_COMMAND_OUTPUT })
    : session.exec(command)
}

async function listMissing(
  session: RemoteSshSession,
  images: WrapperContainerImage[],
  cacheDir: string
): Promise<WrapperContainerImage[]> {
  const checks = images.map(
    (image) =>
      `[ -s ${shellQuote(`${cacheDir}/${image.fileName}`)} ] || printf '%s\\n' ${shellQuote(image.fileName)}`
  )
  const result = await session.exec(checks.join('\n'))
  const missing = new Set(result.stdout.split('\n').map((line) => line.trim()))
  return images.filter((image) => missing.has(image.fileName))
}

/** The login node downloads the image itself; `.part-*` then an atomic rename. */
async function fetchOnServer(
  session: RemoteSshSession,
  image: WrapperContainerImage,
  cacheDir: string,
  timeoutMs: number
): Promise<string | undefined> {
  const target = `${cacheDir}/${image.fileName}`
  const partial = `${target}.part-${randomUUID()}`
  const seconds = Math.max(60, Math.floor(timeoutMs / 1000) - 30)
  const command = [
    `mkdir -p ${shellQuote(cacheDir)}`,
    `if curl -fsSL --connect-timeout 15 --max-time ${seconds} -o ${shellQuote(partial)} ${shellQuote(image.url)}; then`,
    `  mv -f ${shellQuote(partial)} ${shellQuote(target)}`,
    'else',
    `  rc=$?; rm -f ${shellQuote(partial)}; exit "$rc"`,
    'fi'
  ].join('\n')
  const result = await run(session, command, timeoutMs)
  return result.code === 0 ? undefined : result.stderr.trim() || `curl exit ${result.code}`
}

/** Downloads on this machine, uploads to `.part-*`, then renames into place. */
async function fetchHereAndUpload(
  session: RemoteSshSession,
  image: WrapperContainerImage,
  cacheDir: string,
  download: (url: string, target: string) => Promise<void>,
  uploadTimeoutMs: number
): Promise<void> {
  const localDir = mkdtempSync(join(tmpdir(), 'phi-image-'))
  const target = `${cacheDir}/${image.fileName}`
  const partial = `${target}.part-${randomUUID()}`
  try {
    const localFile = join(localDir, image.fileName)
    await download(image.url, localFile)
    await session.mkdirp(cacheDir)
    try {
      await session.uploadFile(localFile, partial, { timeoutMs: uploadTimeoutMs })
      const moved = await session.exec(`mv -f ${shellQuote(partial)} ${shellQuote(target)}`)
      if (moved.code !== 0) throw new Error(moved.stderr.trim() || '无法移动上传的镜像')
    } catch (error) {
      await session.exec(`rm -f ${shellQuote(partial)}`).catch(() => undefined)
      throw error
    }
  } finally {
    rmSync(localDir, { recursive: true, force: true })
  }
}

/**
 * Makes sure every image is in `cacheDir` on the server. Never throws for a
 * single image: whatever cannot be staged comes back in `failed`, so the
 * caller can warn and still start the run (the nodes may be online after all).
 */
export async function stageSingularityImages(
  session: RemoteSshSession,
  options: StageImagesOptions
): Promise<StageImagesResult> {
  const { cacheDir, onOutput } = options
  const download = options.downloadLocally ?? downloadOverHttp
  const remoteTimeoutMs = options.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS
  const uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS
  const missing = await listMissing(session, options.images, cacheDir)
  const result: StageImagesResult = { staged: [], failed: [] }
  if (missing.length === 0) return result

  onOutput?.(`准备镜像：缓存 ${cacheDir} 中缺少 ${missing.length} 个，开始下载。\n`)
  for (const [index, image] of missing.entries()) {
    const label = `[${index + 1}/${missing.length}] ${image.fileName}`
    const serverError = await fetchOnServer(session, image, cacheDir, remoteTimeoutMs).catch(
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    )
    if (serverError === undefined) {
      onOutput?.(`准备镜像 ${label}：已由服务器下载。\n`)
      result.staged.push(image.fileName)
      continue
    }
    onOutput?.(`准备镜像 ${label}：服务器无法下载（${serverError}），改为从本机下载后上传。\n`)
    try {
      await fetchHereAndUpload(session, image, cacheDir, download, uploadTimeoutMs)
      onOutput?.(`准备镜像 ${label}：已从本机上传。\n`)
      result.staged.push(image.fileName)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      onOutput?.(`准备镜像 ${label}：失败（${reason}）。\n`)
      result.failed.push({ fileName: image.fileName, reason })
    }
  }
  return result
}
