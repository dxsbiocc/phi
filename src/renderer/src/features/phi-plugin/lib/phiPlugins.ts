import semver from 'semver'

import type { ManagedEnvironmentState } from '../../../../../shared/environmentTypes'
import { localizePhiPluginProblemMessage } from '../../../../../shared/phiPluginProblems'
import type { PhiPluginProblemView } from '../../../../../shared/phiPluginTypes'

type PluginComponentCollection = {
  agents?: readonly string[]
  skills?: readonly string[]
  scriptTools?: readonly string[]
  environments?: readonly unknown[]
}

const ENVIRONMENT_STATE_LABELS: Record<ManagedEnvironmentState, string> = {
  absent: '未构建',
  building: '构建中',
  ready: '已就绪',
  failed: '构建失败',
  drifted: '需要修复'
}

export function phiPluginSourceLabel(source: 'bundled' | 'local'): string {
  return source === 'bundled' ? '内置' : '本地'
}

export function phiPluginEnabledLabel(enabled: boolean): string {
  return enabled ? '已启用' : '已停用'
}

export function phiPluginEnvironmentStateLabel(state: ManagedEnvironmentState): string {
  return ENVIRONMENT_STATE_LABELS[state]
}

export function phiPluginComponentSummary(plugin: PluginComponentCollection): string {
  const parts = [
    [plugin.agents?.length ?? 0, '个智能体'],
    [plugin.skills?.length ?? 0, '个技能'],
    [plugin.scriptTools?.length ?? 0, '个脚本工具'],
    [plugin.environments?.length ?? 0, '个环境']
  ] as const
  const visible = parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`)
  return visible.length > 0 ? visible.join(' · ') : '未声明可显示的组件'
}

export function phiPluginComponentName(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return (normalized.split('/').filter(Boolean).at(-1) ?? path).replace(/\.md$/i, '')
}

export function isSemanticUpgrade(
  installedVersion: string | undefined,
  candidateVersion: string | undefined
): boolean {
  if (!installedVersion || !candidateVersion) return false
  if (!semver.valid(installedVersion) || !semver.valid(candidateVersion)) return false
  return semver.gt(candidateVersion, installedVersion)
}

export function formatPhiPluginProblems(
  problems: readonly PhiPluginProblemView[],
  fallback = '操作失败，请重试。'
): string {
  if (problems.length === 0) return fallback
  return problems
    .map((problem) => {
      const provided = problem.displayMessage?.trim()
      if (provided) return provided
      const label = problem.level === 'error' ? '错误' : '警告'
      const location = problem.path.trim() ? `（${problem.path}）` : ''
      return `${label}${location}：${localizePhiPluginProblemMessage(problem.message)}`
    })
    .join('\n')
}
