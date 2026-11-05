import { statSync } from 'node:fs'
import { join } from 'node:path'

import type { EnvironmentBuildEstimate } from '../../../shared/environmentBuildTypes'
import { parseExplicitLock, parseLockDownloadBytes } from './contract'

export type BuildEstimate = EnvironmentBuildEstimate

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) return String(error.code)
  return undefined
}

/** Archive file name from an explicit-lock URL (`…/name.conda#md5`). */
export function packageArchiveName(url: string): string {
  const hash = url.indexOf('#')
  const bare = hash === -1 ? url : url.slice(0, hash)
  let pathname: string
  try {
    pathname = new URL(bare).pathname
  } catch {
    throw new Error(`invalid conda package url '${url}'`)
  }
  const filename = pathname
    .split('/')
    .filter((part) => part.length > 0)
    .at(-1)
  if (!filename) throw new Error(`invalid conda package url '${url}'`)
  try {
    return decodeURIComponent(filename)
  } catch {
    return filename
  }
}

/** Extracted package directory: the archive name without `.conda` or `.tar.bz2`. */
export function packageExtractDir(filename: string): string {
  if (filename.endsWith('.tar.bz2')) return filename.slice(0, -'.tar.bz2'.length)
  if (filename.endsWith('.conda')) return filename.slice(0, -'.conda'.length)
  return filename
}

function fileSize(path: string): number | undefined {
  try {
    const stat = statSync(path)
    return stat.isFile() ? stat.size : undefined
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

function cacheProgress(
  pkgs: string,
  entries: readonly { url: string }[],
  share: number | undefined
): { cachedPackages: number; cachedBytes: number } {
  let cachedPackages = 0
  let cachedBytes = 0
  for (const entry of entries) {
    const filename = packageArchiveName(entry.url)
    const archiveSize = fileSize(join(pkgs, filename))
    const extractedOnly =
      archiveSize === undefined && isDirectory(join(pkgs, packageExtractDir(filename)))
    if (archiveSize === undefined && !extractedOnly) continue
    cachedPackages += 1
    if (archiveSize !== undefined) cachedBytes += archiveSize
    else if (share !== undefined) cachedBytes += share
  }
  return { cachedPackages, cachedBytes }
}

/** An extracted package with no archive counts as its share of the total download size. */
export function estimateBuild(root: string, lockText: string, runtime?: 'wsl2'): BuildEstimate {
  const parsed = parseExplicitLock(lockText)
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
  const downloadBytes = parseLockDownloadBytes(lockText)
  const packages = parsed.entries.length
  const share = downloadBytes !== undefined && packages > 0 ? downloadBytes / packages : undefined
  // The WSL cache belongs to the guest. Avoid synchronous scans over its network share.
  const { cachedPackages, cachedBytes } =
    runtime === 'wsl2'
      ? { cachedPackages: 0, cachedBytes: 0 }
      : cacheProgress(join(root, 'pkgs'), parsed.entries, share)
  const estimate: BuildEstimate = { packages, cachedPackages }
  if (downloadBytes !== undefined) {
    estimate.downloadBytes = downloadBytes
    estimate.remainingBytes = Math.max(0, downloadBytes - cachedBytes)
  }
  return estimate
}
