import type { EnvironmentBuildEstimate } from '../../../shared/environmentBuildTypes'
import { getUiLanguage, type UiLanguage } from './i18n'

export function formatEnvironmentSize(
  bytes: number | undefined,
  language: UiLanguage = getUiLanguage()
): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0)
    return language === 'en' ? 'Unknown' : '未知'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unitIndex
  const precision = unitIndex === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

export function formatBuildEstimate(
  estimate: EnvironmentBuildEstimate | undefined,
  language: UiLanguage = getUiLanguage()
): string {
  if (language === 'en') {
    if (!estimate) return 'Download size unavailable'
    const summary = `${estimate.packages} packages (${estimate.cachedPackages} cached)`
    const download =
      estimate.remainingBytes === undefined
        ? 'Download size unavailable'
        : estimate.remainingBytes === 0
          ? 'No download needed'
          : `Estimated download ${formatEnvironmentSize(estimate.remainingBytes, language)}`
    return `${download} · ${summary}`
  }
  if (!estimate) return '下载量暂不可用'
  const packageSummary = `${estimate.packages} 个包（${estimate.cachedPackages} 个已缓存）`
  if (estimate.remainingBytes === undefined) return `下载量暂不可用 · ${packageSummary}`
  if (estimate.remainingBytes === 0) return `无需下载 · ${packageSummary}`
  return `预计下载 ${formatEnvironmentSize(estimate.remainingBytes, language)} · ${packageSummary}`
}
