import semver from 'semver'

import type {
  PhiPluginInstallPreview,
  PhiPluginListItem,
  PhiPluginMutationResult,
  PhiPluginProblemView
} from '../../../shared/phiPluginTypes'
import { localizePhiPluginProblemMessage } from '../../../shared/phiPluginProblems'
import { getEnablementSnapshot, isCoreSkill } from '../enablement'
import { buildPhiPluginListItem } from './details'
import { listInstalledPlugins, type PluginLifecycleResult } from './loader'
import { validatePlugin, type PluginProblem } from './validate'

export interface PhiPluginManagementView {
  listItems: () => PhiPluginListItem[]
  problem: (problem: PluginProblem) => PhiPluginProblemView
  mutation: (result: PluginLifecycleResult) => PhiPluginMutationResult
  failedMutation: (path: string, message: string) => PhiPluginMutationResult
  installPreview: (path: string) => PhiPluginInstallPreview
}

export function createPhiPluginManagementView(agentDir: string): PhiPluginManagementView {
  const listItems = (): PhiPluginListItem[] => {
    const enablement = getEnablementSnapshot({ agentDir })
    return listInstalledPlugins({ agentDir }).map((plugin) =>
      buildPhiPluginListItem(plugin, {
        isSkillEnabled: (name) => isCoreSkill(name) || enablement.global[`skill:${name}`] !== false
      })
    )
  }

  const problem = (entry: PluginProblem): PhiPluginProblemView => {
    const label = entry.level === 'error' ? '错误' : '警告'
    return {
      ...entry,
      displayMessage: `${label}（${entry.path}）：${localizePhiPluginProblemMessage(entry.message)}`
    }
  }

  const mutation = (result: PluginLifecycleResult): PhiPluginMutationResult => ({
    ok: result.ok,
    plugins: listItems(),
    problems: [...result.errors, ...result.warnings].map(problem)
  })

  const failedMutation = (path: string, message: string): PhiPluginMutationResult =>
    mutation({
      ok: false,
      errors: [{ level: 'error', path, message }],
      warnings: []
    })

  const installPreview = (path: string): PhiPluginInstallPreview => {
    const validation = validatePlugin(path)
    const problems = [...validation.errors, ...validation.warnings].map(problem)
    if (!validation.ok || !validation.plugin) return { ok: false, path, problems }

    const { manifest } = validation.plugin
    const existing = listInstalledPlugins({ agentDir }).find((plugin) => plugin.id === manifest.id)
    return {
      ok: true,
      path,
      action: !existing
        ? 'install'
        : semver.gt(manifest.version, existing.version)
          ? 'upgrade'
          : 'same-or-older',
      id: manifest.id,
      version: manifest.version,
      title: manifest.title,
      summary: manifest.summary,
      ...(existing ? { installedVersion: existing.version } : {}),
      problems
    }
  }

  return { listItems, problem, mutation, failedMutation, installPreview }
}
