import { resourceUi } from '../../../lib/resourceUi'
import { wrapperCopy } from './wrapperCopy'
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

const KIND_LABEL: Array<[prefix: string, key: 'subworkflow' | 'workflow' | 'module']> = [
  ['subworkflow-', 'subworkflow'],
  ['workflow-', 'workflow'],
  ['module-', 'module']
]

function kindOf(id: string): string {
  const key = KIND_LABEL.find(([prefix]) => id.startsWith(prefix))?.[1]
  return key ? wrapperCopy[key] : resourceUi.other
}

function itemOf(entry: PackageInstallPlanView['packages'][number]): WrapperInstallItem {
  return {
    id: entry.id,
    name: wrapperFamilyName(entry.id),
    // A confirmation dialog can stay open while the interface language changes.
    get kind() {
      return kindOf(entry.id)
    },
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
    get kind() {
      return kindOf(rootId)
    },
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
