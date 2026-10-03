import type { EnvironmentBuildEstimate } from '../../../shared/environmentBuildTypes'

export function formatEnvironmentSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unitIndex
  const precision = unitIndex === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

export function formatBuildEstimate(estimate: EnvironmentBuildEstimate | undefined): string {
  if (!estimate) return '下载量暂不可用'
  const packageSummary = `${estimate.packages} 个包（${estimate.cachedPackages} 个已缓存）`
  if (estimate.remainingBytes === undefined) return `下载量暂不可用 · ${packageSummary}`
  if (estimate.remainingBytes === 0) return `无需下载 · ${packageSummary}`
  return `预计下载 ${formatEnvironmentSize(estimate.remainingBytes)} · ${packageSummary}`
}
