import type { PackageInstallPlanView } from '../../../../../shared/packageManagerTypes'
import { wrapperFamilyName } from './wrapperFamily'

export interface WrapperInstallItem {
  id: string
  name: string
  kind: string
  version: string
  size: number
}

export interface WrapperInstallSummary {
  root: WrapperInstallItem
  /** Packages installed only because the chosen one needs them, largest first. */
  dependencies: WrapperInstallItem[]
  totalSize: number
  /** Installing more than the chosen package is worth a confirmation. */
  needsConfirmation: boolean
}

const KIND_LABEL: Array<[prefix: string, label: string]> = [
  ['subworkflow-', '子流程'],
  ['workflow-', '工作流'],
  ['module-', '模块']
]

function kindOf(id: string): string {
  return KIND_LABEL.find(([prefix]) => id.startsWith(prefix))?.[1] ?? '其他'
}

function itemOf(entry: PackageInstallPlanView['packages'][number]): WrapperInstallItem {
  return {
    id: entry.id,
    name: wrapperFamilyName(entry.id),
    kind: kindOf(entry.id),
    version: entry.version,
    size: entry.size
  }
}

export function summarizeWrapperInstallPlan(
  plan: PackageInstallPlanView,
  rootId: string
): WrapperInstallSummary {
  const entries = plan.packages.map(itemOf)
  const root = entries.find((entry) => entry.id === rootId) ?? {
    id: rootId,
    name: wrapperFamilyName(rootId),
    kind: kindOf(rootId),
    version: plan.root.version,
    size: 0
  }
  const dependencies = entries
    .filter((entry) => entry.id !== rootId)
    .sort((left, right) => right.size - left.size || left.name.localeCompare(right.name))
  return {
    root,
    dependencies,
    totalSize: plan.totalSize,
    needsConfirmation: dependencies.length > 0
  }
}

export function formatPackageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
