import { gt, valid } from 'semver'

import type { AppUpdateAsset, AppUpdateCheck, AppUpdateInstallMode } from '../shared/appUpdateTypes'

import { errorMessage } from '../shared/errorCodes'
/** Published (non-draft, non-prerelease) releases of this repository are the update source. */
export const RELEASES_REPOSITORY = 'dxsbiocc/phi'
export const RELEASES_PAGE_URL = `https://github.com/${RELEASES_REPOSITORY}/releases/latest`
export const RELEASE_DOWNLOAD_PREFIX = `https://github.com/${RELEASES_REPOSITORY}/releases/download/`
const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPOSITORY}/releases/latest`
const CHECK_TIMEOUT_MS = 10_000

type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface AppUpdatePlatformContext {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
}

interface ParsedGithubAsset {
  name: string
  downloadUrl: string
  size: number
}

function versionOf(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined
  return valid(tag.replace(/^v/, '')) ?? undefined
}

function isTrustedAssetEntry(name: string, downloadUrl: string): boolean {
  return (
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    downloadUrl.startsWith(RELEASE_DOWNLOAD_PREFIX)
  )
}

function parseTrustedAssets(raw: unknown): ParsedGithubAsset[] {
  if (!Array.isArray(raw)) return []
  const parsed: ParsedGithubAsset[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const downloadUrl =
      typeof record.browser_download_url === 'string' ? record.browser_download_url.trim() : ''
    const size = typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : 0
    if (!isTrustedAssetEntry(name, downloadUrl)) continue
    parsed.push({ name, downloadUrl, size: Math.max(0, size) })
  }
  return parsed
}

function pickLinuxInstaller(
  assets: readonly ParsedGithubAsset[],
  env: NodeJS.ProcessEnv
): { matched?: ParsedGithubAsset; installMode: AppUpdateInstallMode } {
  const hasAppImage = typeof env.APPIMAGE === 'string' && env.APPIMAGE.trim().length > 0
  if (hasAppImage) {
    return {
      matched: assets.find((item) => /^phi-[\w.-]+-x86_64\.appimage$/i.test(item.name)),
      installMode: 'auto-replace'
    }
  }
  return {
    matched:
      assets.find((item) => /^phi_[\w.-]+_amd64\.deb$/i.test(item.name)) ??
      assets.find((item) => /^phi-[\w.-]+-x86_64\.appimage$/i.test(item.name)),
    installMode: 'open-installer'
  }
}

/**
 * Picks the installer asset matching the current desktop OS/architecture and
 * pairs it with the release's `SHA256SUMS.txt` URL.
 */
export function selectReleaseUpdateAsset(
  rawAssets: unknown,
  context: AppUpdatePlatformContext = {}
): AppUpdateAsset | undefined {
  const assets = parseTrustedAssets(rawAssets)
  if (assets.length === 0) return undefined
  const platform = context.platform ?? process.platform
  const arch = context.arch ?? process.arch
  const env = context.env ?? process.env
  const checksumAsset = assets.find((item) => item.name === 'SHA256SUMS.txt')

  let matched: ParsedGithubAsset | undefined
  let installMode: AppUpdateInstallMode = 'open-installer'

  if (platform === 'darwin' && arch === 'arm64') {
    matched = assets.find((item) => /^phi-[\w.-]+\.dmg$/i.test(item.name))
  } else if (platform === 'win32' && arch === 'x64') {
    matched = assets.find((item) => /^phi-[\w.-]+-setup\.exe$/i.test(item.name))
    installMode = 'auto-replace'
  } else if (platform === 'linux' && arch === 'x64') {
    const linuxChoice = pickLinuxInstaller(assets, env)
    matched = linuxChoice.matched
    installMode = linuxChoice.installMode
  }

  if (!matched) return undefined
  return {
    name: matched.name,
    downloadUrl: matched.downloadUrl,
    size: matched.size,
    ...(checksumAsset ? { checksumUrl: checksumAsset.downloadUrl } : {}),
    installMode
  }
}

function nonEmptyString(value: unknown, trim = false): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = trim ? value.trim() : value
  return normalized.length > 0 ? normalized : undefined
}

function trustedReleaseUrl(value: unknown): string {
  return typeof value === 'string' &&
    value.startsWith(`https://github.com/${RELEASES_REPOSITORY}/releases/`)
    ? value
    : RELEASES_PAGE_URL
}

function parseReleasePayload(
  base: Pick<AppUpdateCheck, 'currentVersion' | 'checkedAt' | 'releasesUrl'>,
  release: Record<string, unknown>,
  platformContext?: AppUpdatePlatformContext
): AppUpdateCheck {
  const latestVersion = versionOf(release.tag_name)
  if (!latestVersion) return { ...base, status: 'error', error: '最新发布的版本号无效' }
  const current = valid(base.currentVersion)
  const available = current ? gt(latestVersion, current) : false
  const releaseTitle = nonEmptyString(release.name, true)
  const releaseNotes = nonEmptyString(release.body, true) ? String(release.body) : undefined
  const publishedAt = nonEmptyString(release.published_at)
  const asset = available ? selectReleaseUpdateAsset(release.assets, platformContext) : undefined
  return {
    ...base,
    status: available ? 'available' : 'up-to-date',
    latestVersion,
    releasesUrl: trustedReleaseUrl(release.html_url),
    ...(releaseTitle ? { releaseTitle } : {}),
    ...(releaseNotes ? { releaseNotes } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(asset ? { asset } : {})
  }
}

/**
 * Compares this build with the latest published release and extracts release
 * notes plus the verified platform installer asset when an update is available.
 */
export async function checkForAppUpdate(
  currentVersion: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  now: () => Date = () => new Date(),
  platformContext?: AppUpdatePlatformContext
): Promise<AppUpdateCheck> {
  const checkedAt = now().toISOString()
  const base = { currentVersion, checkedAt, releasesUrl: RELEASES_PAGE_URL }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    const response = await fetchImpl(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Phi/${currentVersion}` },
      signal: controller.signal
    })
    if (response.status === 404) return { ...base, status: 'up-to-date' }
    if (!response.ok) {
      return { ...base, status: 'error', error: `更新服务返回 HTTP ${response.status}` }
    }
    const release = (await response.json()) as Record<string, unknown>
    return parseReleasePayload(base, release, platformContext)
  } catch (error) {
    return {
      ...base,
      status: 'error',
      error: controller.signal.aborted ? '检查更新超时' : errorMessage(error)
    }
  } finally {
    clearTimeout(timer)
  }
}
