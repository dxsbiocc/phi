import { readEnablementState, writeEnablementState } from '../enablement'
import { getPhiAgentDir } from '../runtime-paths'
import type { InstallerOptions } from './installer-types'
import { uninstallPackage } from './lifecycle'
import { readWrapperTreeState } from './wrapper-tree'
import { wrapperFamilyName } from '../../../shared/wrapperPackageNames'

export interface WrapperRemovalResult {
  /** `deselected` keeps the bundled files; `uninstalled` deleted the installed package. */
  kind: 'deselected' | 'uninstalled'
  id: string
}

const BUNDLED_REGISTRY = 'bundled-wrappers'

/**
 * Take a wrapper package out of use. A bundled package only drops the user's choice (its files
 * stay for later), an installed one is uninstalled. Either way it is refused while an enabled,
 * chosen package still needs it.
 */
export function removeWrapperPackage(
  id: string,
  options: Pick<InstallerOptions, 'agentDir'> = {}
): WrapperRemovalResult {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const packages = readWrapperTreeState(agentDir).packages
  const target = packages[id]
  if (!target) throw new Error(`软件包 wrapper:${id} 尚未安装`)

  const blockers = enabledChosenPackages(agentDir, id).filter((rootId) =>
    dependencyClosure(rootId, packages).has(id)
  )
  if (blockers.length > 0) {
    const names = blockers.map(wrapperFamilyName).join('、')
    throw new Error(
      `无法移除 ${wrapperFamilyName(id)}：已启用的 ${names} 需要它，请先移除或停用它们。`
    )
  }

  if (target.source.registry === BUNDLED_REGISTRY) {
    clearChoice(id, agentDir)
    return { kind: 'deselected', id }
  }
  uninstallPackage('wrapper', id, { agentDir })
  clearChoice(id, agentDir)
  return { kind: 'uninstalled', id }
}

/** Packages (other than `except`) the user chose and left enabled; installed ones count by default. */
function enabledChosenPackages(agentDir: string, except: string): string[] {
  const state = readEnablementState({ agentDir })
  const packages = readWrapperTreeState(agentDir).packages
  return Object.keys(packages).filter((candidate) => {
    if (candidate === except) return false
    const key = `wrapper:${candidate}`
    const values = [
      state.global[key],
      ...Object.values(state.projects).map((project) => project[key])
    ].filter((value): value is boolean => value !== undefined)
    if (values.length > 0) return values.some(Boolean)
    return packages[candidate].source.registry !== BUNDLED_REGISTRY
  })
}

function dependencyClosure(
  rootId: string,
  packages: ReturnType<typeof readWrapperTreeState>['packages']
): Set<string> {
  const seen = new Set<string>()
  const visit = (id: string): void => {
    for (const dependency of packages[id]?.manifest.dependsOn ?? []) {
      if (dependency.type !== 'wrapper' || seen.has(dependency.id)) continue
      seen.add(dependency.id)
      visit(dependency.id)
    }
  }
  visit(rootId)
  return seen
}

function clearChoice(id: string, agentDir: string): void {
  const state = readEnablementState({ agentDir })
  const key = `wrapper:${id}`
  const without = (values: Record<string, boolean>): Record<string, boolean> =>
    Object.fromEntries(Object.entries(values).filter(([name]) => name !== key))
  writeEnablementState(
    {
      ...state,
      global: without(state.global),
      projects: Object.fromEntries(
        Object.entries(state.projects)
          .map(([path, values]) => [path, without(values)] as const)
          .filter(([, values]) => Object.keys(values).length > 0)
      )
    },
    { agentDir }
  )
}
