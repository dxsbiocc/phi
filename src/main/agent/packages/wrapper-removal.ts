import { readEnablementState, writeEnablementState } from '../enablement'
import { getPhiAgentDir } from '../runtime-paths'
import type { InstallerOptions } from './installer-types'
import { uninstallPackage } from './lifecycle'
import { readWrapperTreeState } from './wrapper-tree'
import type {
  WrapperRemovalDependent,
  WrapperRemovalPreview,
  WrapperRemovalView
} from '../../../shared/packageManagerTypes'
import { wrapperFamilyName } from '../../../shared/wrapperPackageNames'

export type WrapperRemovalResult = WrapperRemovalView

export interface WrapperRemovalOptions {
  agentDir?: string
  /** Disable enabled dependents instead of refusing the removal; the user confirms this first. */
  disableDependents?: boolean
}

const BUNDLED_REGISTRY = 'bundled-wrappers'

/**
 * Take a wrapper package out of use. Every wrapper package now comes from the catalog, so
 * removal always deletes the files it owns. An enabled dependent keeps the package in use, so
 * it is either refused or, with `disableDependents`, switched off first.
 */
export function removeWrapperPackage(
  id: string,
  options: WrapperRemovalOptions = {}
): WrapperRemovalResult {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const { dependents } = removalTarget(id, agentDir)

  if (dependents.length > 0 && !options.disableDependents) {
    const names = dependents.map((dependent) => dependent.name).join('、')
    throw new Error(
      `无法移除 ${wrapperFamilyName(id)}：已启用的 ${names} 需要它，请先移除或停用它们。`
    )
  }
  if (dependents.length > 0) {
    disableDependents(
      dependents.map((dependent) => dependent.id),
      agentDir
    )
  }

  uninstallPackage('wrapper', id, { agentDir, allowInstalledDependents: true })
  clearChoice(id, agentDir)
  return { id, disabledDependents: dependents }
}

/** Report what a removal would do without changing anything, so the UI can confirm it first. */
export function previewWrapperRemoval(
  id: string,
  options: Pick<InstallerOptions, 'agentDir'> = {}
): WrapperRemovalPreview {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const { dependents } = removalTarget(id, agentDir)
  return {
    id,
    name: wrapperFamilyName(id),
    dependents
  }
}

function removalTarget(
  id: string,
  agentDir: string
): {
  target: ReturnType<typeof readWrapperTreeState>['packages'][string]
  dependents: WrapperRemovalDependent[]
} {
  const packages = readWrapperTreeState(agentDir).packages
  const target = packages[id]
  if (!target) throw new Error(`软件包 wrapper:${id} 尚未安装`)

  const state = readEnablementState({ agentDir })
  const dependents = enabledChosenPackages(state, packages, id)
    .filter((rootId) => dependencyClosure(rootId, packages).has(id))
    .map((dependentId) => ({ id: dependentId, name: wrapperFamilyName(dependentId) }))
  return { target, dependents }
}

/** Packages (other than `except`) the user chose and left enabled; installed ones count by default. */
function enabledChosenPackages(
  state: ReturnType<typeof readEnablementState>,
  packages: ReturnType<typeof readWrapperTreeState>['packages'],
  except: string
): string[] {
  return Object.keys(packages).filter(
    (candidate) => candidate !== except && enabledInAnyScope(state, candidate, packages)
  )
}

/**
 * Enablement is resolved per project, so a package counts as enabled when any scope
 * turns it on. Without an explicit value, bundled packages stay out of use until
 * chosen and installed ones are enabled by default.
 */
function enabledInAnyScope(
  state: ReturnType<typeof readEnablementState>,
  id: string,
  packages: ReturnType<typeof readWrapperTreeState>['packages']
): boolean {
  const key = `wrapper:${id}`
  const values = [
    state.global[key],
    ...Object.values(state.projects).map((project) => project[key])
  ].filter((value): value is boolean => value !== undefined)
  if (values.length > 0) return values.some(Boolean)
  return packages[id]?.source.registry !== BUNDLED_REGISTRY
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

/** Turn dependents off everywhere, including project overrides that would otherwise re-enable them. */
function disableDependents(ids: readonly string[], agentDir: string): void {
  const state = readEnablementState({ agentDir })
  for (const id of ids) {
    const key = `wrapper:${id}`
    state.global[key] = false
    for (const [projectPath, values] of Object.entries(state.projects)) {
      delete values[key]
      if (Object.keys(values).length === 0) delete state.projects[projectPath]
    }
  }
  writeEnablementState(state, { agentDir })
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
