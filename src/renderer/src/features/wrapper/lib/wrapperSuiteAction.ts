import type { PackageUpdateView } from '../../../../../shared/packageManagerTypes'
import { resourceUi } from '../../../lib/resourceUi'
import type { OfficialWrapperToolChoice } from './officialWrapperCatalog'
import type { WrapperCatalogChoice } from './wrapperCatalog'
import type { WrapperInstallItem, WrapperInstallSummary } from './wrapperInstallPlan'

/** One package install planned for a whole tool group. */
export interface WrapperSuiteInstallItem {
  choice: WrapperCatalogChoice
  summary: WrapperInstallSummary
}

/** Everything installing a whole tool group would add, merged across its tools. */
export interface WrapperSuiteInstallSummary {
  tools: WrapperInstallItem[]
  dependencies: WrapperInstallItem[]
  totalSize: number
  needsConfirmation: boolean
}

export type WrapperSuiteActionState = 'installed' | 'update' | 'install'

export interface WrapperSuiteAction {
  state: WrapperSuiteActionState
  kind: 'install' | 'update' | 'uninstall'
  label: string
  /** Installed tools that have an update and are the target of an update action. */
  updates: WrapperCatalogChoice[]
}

/** The catalog update list is global; only wrapper packages matter for a tool group. */
export function wrapperSuiteUpdateIds(updates: readonly PackageUpdateView[]): ReadonlySet<string> {
  return new Set(updates.filter((update) => update.type === 'wrapper').map((update) => update.id))
}

/**
 * Installed means every tool is installed and enabled. Any installed tool with an update turns
 * the group action into Update; otherwise missing tools need Install.
 */
export function wrapperSuiteAction(
  choices: readonly OfficialWrapperToolChoice[],
  updateIds: ReadonlySet<string> = new Set()
): WrapperSuiteAction {
  const updates = choices
    .filter(({ choice }) => choice.installed && updateIds.has(choice.id))
    .map(({ choice }) => choice)
  if (updates.length > 0) {
    return { state: 'update', kind: 'update', label: resourceUi.update, updates }
  }
  const installedAndEnabled =
    choices.length > 0 && choices.every(({ choice }) => choice.installed && choice.enabled)
  if (installedAndEnabled) {
    return { state: 'installed', kind: 'uninstall', label: resourceUi.uninstall, updates: [] }
  }
  return { state: 'install', kind: 'install', label: resourceUi.install, updates: [] }
}

/** Merge per-tool plans so one group confirmation lists every tool and each dependency once. */
export function summarizeWrapperSuiteInstall(
  plans: readonly WrapperSuiteInstallItem[]
): WrapperSuiteInstallSummary {
  const tools = plans.map(({ summary }) => summary.root)
  const toolIds = new Set(tools.map((tool) => tool.id))
  const packages = new Map<string, WrapperInstallItem>()
  for (const { summary } of plans) {
    for (const item of [summary.root, ...summary.dependencies]) {
      if (!packages.has(item.id)) packages.set(item.id, item)
    }
  }
  const allPackages = [...packages.values()]
  return {
    tools,
    dependencies: allPackages
      .filter((item) => !toolIds.has(item.id))
      .sort((left, right) => right.size - left.size || left.name.localeCompare(right.name)),
    totalSize: allPackages.reduce((total, item) => total + item.size, 0),
    needsConfirmation: plans.some(({ summary }) => summary.needsConfirmation)
  }
}

/** One busy key per group, so the group button disables while its tools run sequentially. */
export function wrapperSuiteBusyKey(suite: string): string {
  return `suite:${suite}`
}
