import { resourceUi } from '../../../lib/resourceUi'
import { pluginCopy } from './pluginCopy'
import semver from 'semver'

import type { ManagedEnvironmentState } from '../../../../../shared/environmentTypes'
import type { PhiPluginProblemView } from '../../../../../shared/phiPluginTypes'

type PluginComponentCollection = {
  agents?: readonly string[]
  skills?: readonly string[]
  scriptTools?: readonly string[]
  environments?: readonly unknown[]
  usedEnvironments?: readonly unknown[]
}

/** Keep the official plugin's English name when older packages carry its legacy title. */
export function phiPluginDisplayTitle(plugin: { id: string; title: string }): string {
  return plugin.id === 'visualization' && plugin.title.trim() === '科研绘图'
    ? 'Visualization'
    : plugin.title
}

export type PhiPluginSourceCategory = 'bundled' | 'registry' | 'local'

export const phiPluginSourceCategoryOrder: readonly PhiPluginSourceCategory[] = [
  'bundled',
  'registry',
  'local'
]

export const phiPluginSourceCategoryLabels: Record<PhiPluginSourceCategory, string> = {
  get bundled() {
    return resourceUi.builtIn
  },
  get registry() {
    return pluginCopy.registrySource
  },
  get local() {
    return resourceUi.localDirectory
  }
}

const ENVIRONMENT_STATE_LABELS: Record<ManagedEnvironmentState, string> =
  pluginCopy.environmentStates

export function phiPluginSourceLabel(source: 'bundled' | 'local'): string {
  return source === 'bundled' ? resourceUi.builtIn : pluginCopy.localSource
}

export function phiPluginDistributionLabel(distribution: PhiPluginSourceCategory): string {
  return phiPluginSourceCategoryLabels[distribution]
}

export function phiPluginEnabledLabel(enabled: boolean): string {
  return enabled ? resourceUi.enabled : resourceUi.disabled
}

export function phiPluginEnvironmentStateLabel(state: ManagedEnvironmentState): string {
  return ENVIRONMENT_STATE_LABELS[state]
}

export function phiPluginComponentSummary(plugin: PluginComponentCollection): string {
  const parts = [
    [plugin.agents?.length ?? 0, pluginCopy.summaryComponents.agent],
    [plugin.skills?.length ?? 0, pluginCopy.summaryComponents.skill],
    [plugin.scriptTools?.length ?? 0, pluginCopy.summaryComponents.script],
    [
      plugin.usedEnvironments?.length ?? plugin.environments?.length ?? 0,
      pluginCopy.summaryComponents.environment
    ]
  ] as const
  const visible = parts
    .filter(([count]) => count > 0)
    .map(([count, label]) => pluginCopy.componentCount(count, label))
  return visible.length > 0 ? visible.join(' · ') : pluginCopy.noComponents
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
  fallback: string = pluginCopy.operationFailed
): string {
  if (problems.length === 0) return fallback
  return problems
    .map((problem) => {
      const label = pluginCopy.problemLabels[problem.level]
      const location = problem.path.trim() ? ` (${problem.path})` : ''
      return `${label}${location}: ${problem.message.trim() || pluginCopy.operationFailed}`
    })
    .join('\n')
}
