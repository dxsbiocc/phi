import { gt, valid } from 'semver'

import type { AppUpdateCheck } from '../shared/appUpdateTypes'

import { errorMessage } from '../shared/errorCodes'
/** Published (non-draft, non-prerelease) releases of this repository are the update source. */
export const RELEASES_REPOSITORY = 'dxsbiocc/phi'
export const RELEASES_PAGE_URL = `https://github.com/${RELEASES_REPOSITORY}/releases/latest`
const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPOSITORY}/releases/latest`
const CHECK_TIMEOUT_MS = 10_000

type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

function versionOf(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined
  return valid(tag.replace(/^v/, '')) ?? undefined
}

/**
 * Compares this build with the latest published release. Only reports; downloading and
 * installing stay manual until the app is signed, which macOS auto-update requires.
 */
export async function checkForAppUpdate(
  currentVersion: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  now: () => Date = () => new Date()
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
    // No published release yet.
    if (response.status === 404) return { ...base, status: 'up-to-date' }
    if (!response.ok) {
      return { ...base, status: 'error', error: `更新服务返回 HTTP ${response.status}` }
    }
    const release = (await response.json()) as Record<string, unknown>
    const latestVersion = versionOf(release.tag_name)
    if (!latestVersion) return { ...base, status: 'error', error: '最新发布的版本号无效' }
    const current = valid(currentVersion)
    const available = current ? gt(latestVersion, current) : false
    const releaseUrl =
      typeof release.html_url === 'string' &&
      release.html_url.startsWith(`https://github.com/${RELEASES_REPOSITORY}/releases/`)
        ? release.html_url
        : RELEASES_PAGE_URL
    return {
      ...base,
      status: available ? 'available' : 'up-to-date',
      latestVersion,
      releasesUrl: releaseUrl,
      ...(typeof release.published_at === 'string' ? { publishedAt: release.published_at } : {})
    }
  } catch (error) {
    const aborted = controller.signal.aborted
    return {
      ...base,
      status: 'error',
      error: aborted ? '检查更新超时' : errorMessage(error)
    }
  } finally {
    clearTimeout(timer)
  }
}
