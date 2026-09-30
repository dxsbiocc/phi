import type { EnvironmentBuildEstimate } from '../../../shared/environmentBuildTypes'
import type { ConfirmBuildRequest } from './skill-host'

/** The in-chat question asked before a missing environment is built. */
export const BUILD_NOW = '现在构建'

function environmentBuildSizeText(estimate: EnvironmentBuildEstimate): string {
  if (estimate.remainingBytes === undefined) return '下载大小未知'
  return `需下载约 ${formatDownloadBytes(estimate.remainingBytes)}（共 ${String(estimate.packages)} 个包，已缓存 ${String(estimate.cachedPackages)}）`
}

export function formatDownloadBytes(bytes: number): string {
  const gibibyte = 1024 * 1024 * 1024
  const mebibyte = 1024 * 1024
  if (bytes >= gibibyte) return `${formatDownloadAmount(bytes / gibibyte)} GB`
  return `${formatDownloadAmount(bytes / mebibyte)} MB`
}

function formatDownloadAmount(value: number): string {
  if (value >= 10) return String(Math.round(value))
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

export function environmentBuildQuestion(request: ConfirmBuildRequest): string {
  const size = environmentBuildSizeText(request.estimate)
  if (request.agent) {
    return `智能体 ${request.agent} 需要环境 ${request.ref}，尚未安装。现在构建吗？${size}`
  }
  return `技能 ${request.skill} 需要环境 ${request.ref}，尚未安装。现在构建吗？${size}`
}

export function confirmedEnvironmentBuild(response: unknown): boolean {
  if (!isRecord(response) || response.cancelled === true || typeof response.error === 'string') {
    return false
  }
  if (!Array.isArray(response.answers)) return false
  return response.answers.some((answer) => isRecord(answer) && answer.answer === BUILD_NOW)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
