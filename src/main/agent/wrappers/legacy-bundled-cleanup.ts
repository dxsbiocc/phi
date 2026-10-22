// Retires the wrapper payloads older builds seeded into the user's tree at startup.
//
// Installable content now comes only from the catalog
// (docs/decisions/content-distribution.md, "Use phi-packages as the sole source"). Older
// builds copied a bundled pack into `~/.phi/wrappers` before the user chose anything, so
// those records are neither catalog installs nor user choices. Leaving them in place makes
// them shadow catalog packages during dependency planning and forces removal to keep files
// the user never asked to keep. This pass keeps only what is still in use: chosen packages
// and packages another installed package depends on are replaced with catalog copies first,
// then every other legacy record and its files are removed.
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { errorMessage } from '../../../shared/errorCodes'
import { isLegacyPackageRegistry } from '../../../shared/packageSourceIds'
import { readEnablementState, writeEnablementState } from '../enablement'
import { installPackages } from '../packages/lifecycle'
import { syncOfficialRegistry, prepareOfficialPackageInstall } from '../packages/official-registry'
import { planInstall } from '../packages/planning'
import {
  installStagedWrapperPackages,
  readWrapperTreeState,
  setWrapperPackageInstalledBy,
  type WrapperTreePackageState
} from '../packages/wrapper-tree'
import { getPhiAgentDir } from '../runtime-paths'

export interface LegacyBundledCleanupResult {
  /** Legacy records removed without a catalog replacement. */
  removed: string[]
  /** Legacy records replaced by their catalog package. */
  replaced: string[]
  /** Records that are still in use but could not be replaced; retried on the next start. */
  failed: Array<{ id: string; reason: string }>
}

export interface LegacyBundledCleanupOptions {
  agentDir?: string
  /** Passed to install planning; `index.ts` supplies it from `app.getVersion()`. */
  appVersion?: string
  /** Test seam: install these id/version roots from the catalog. */
  installCatalog?: (
    roots: LegacyBundledRoot[],
    agentDir: string,
    appVersion?: string
  ) => Promise<void>
}

export interface LegacyBundledRoot {
  id: string
  version: string
}

export function isLegacyBundledWrapper(state: WrapperTreePackageState): boolean {
  return isLegacyPackageRegistry(state.source.registry)
}

/**
 * Legacy records still in use: chosen by the user (`wrapper:<id>` true in any scope) or
 * required, directly or transitively, by an installed package. The dependency closure is
 * taken over legacy records only, because all callers start from a legacy id.
 */
export function legacyBundledKeepIds(
  packages: Readonly<Record<string, WrapperTreePackageState>>,
  chosen: ReadonlySet<string>
): Set<string> {
  const legacy = new Set(Object.keys(packages).filter((id) => isLegacyBundledWrapper(packages[id])))
  const needed = new Set<string>()
  for (const id of Object.keys(packages)) {
    if (legacy.has(id)) continue
    for (const dependency of dependencyClosure(packages, id)) {
      if (legacy.has(dependency)) needed.add(dependency)
    }
  }
  const keep = new Set<string>()
  const visit = (id: string): void => {
    if (keep.has(id)) return
    keep.add(id)
    for (const dependency of packages[id]?.manifest.dependsOn ?? []) {
      if (dependency.type === 'wrapper' && legacy.has(dependency.id)) visit(dependency.id)
    }
  }
  for (const id of chosen) if (legacy.has(id)) visit(id)
  for (const id of needed) visit(id)
  return keep
}

export async function retireLegacyBundledWrappers(
  options: LegacyBundledCleanupOptions = {}
): Promise<LegacyBundledCleanupResult> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const installed = readWrapperTreeState(agentDir).packages
  const legacyIds = Object.keys(installed).filter((id) => isLegacyBundledWrapper(installed[id]))
  if (legacyIds.length === 0) {
    removeBundledMarker(agentDir)
    return { removed: [], replaced: [], failed: [] }
  }

  const chosen = chosenWrapperIds(agentDir)
  const keep = legacyBundledKeepIds(installed, chosen)
  const failures = new Map<string, string>()
  const installCatalog = options.installCatalog ?? installFromOfficialCatalog

  const attempt = async (roots: LegacyBundledRoot[]): Promise<void> => {
    if (roots.length === 0) return
    try {
      await installCatalog(roots, agentDir, options.appVersion)
    } catch (error) {
      const reason = errorMessage(error)
      for (const root of roots) if (!failures.has(root.id)) failures.set(root.id, reason)
    }
  }

  // A dependent installs its kept dependencies as `dependency`; a chosen package is its own
  // root, which also promotes it to `user`. Both runs are safe to repeat: planning skips
  // versions that are already installed from the catalog.
  await attempt(dependentRoots(installed, keep))
  await attempt(
    [...keep]
      .filter((id) => chosen.has(id) && packagesAreLegacy(agentDir, id))
      .map((id) => ({ id, version: installed[id].version }))
  )
  // Last resort for a kept record whose dependent install failed: install the record itself.
  await attempt(
    [...keep]
      .filter((id) => packagesAreLegacy(agentDir, id))
      .map((id) => ({ id, version: installed[id].version }))
  )

  const afterInstall = readWrapperTreeState(agentDir).packages
  const replaced = [...keep]
    .filter((id) => afterInstall[id] && !isLegacyBundledWrapper(afterInstall[id]))
    .sort()
  // A kept record nobody chose is only here because an installed package needs it, even when
  // the fallback root installed it on its own.
  for (const id of replaced) {
    if (!chosen.has(id)) setWrapperPackageInstalledBy(id, 'dependency', agentDir)
  }
  const stillLegacy = new Set([...keep].filter((id) => isLegacyBundledWrapper(afterInstall[id])))
  const retire = legacyIds.filter((id) => !keep.has(id)).sort()
  if (retire.length > 0) {
    installStagedWrapperPackages([], agentDir, retire)
    clearChoices(retire, agentDir)
  }
  removeBundledMarker(agentDir)
  return {
    removed: retire,
    replaced,
    failed: [...failures]
      .filter(([id]) => stillLegacy.has(id))
      .map(([id, reason]) => ({ id, reason }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }
}

function packagesAreLegacy(agentDir: string, id: string): boolean {
  const state = readWrapperTreeState(agentDir).packages[id]
  return state !== undefined && isLegacyBundledWrapper(state)
}

function chosenWrapperIds(agentDir: string): Set<string> {
  const state = readEnablementState({ agentDir })
  const chosen = new Set<string>()
  for (const [key, value] of Object.entries(state.global)) {
    if (value && key.startsWith('wrapper:')) chosen.add(key.slice('wrapper:'.length))
  }
  for (const values of Object.values(state.projects)) {
    for (const [key, value] of Object.entries(values)) {
      if (value && key.startsWith('wrapper:')) chosen.add(key.slice('wrapper:'.length))
    }
  }
  return chosen
}

function dependencyClosure(
  packages: Readonly<Record<string, WrapperTreePackageState>>,
  rootId: string
): Set<string> {
  const seen = new Set<string>()
  const visit = (id: string): void => {
    for (const dependency of packages[id]?.manifest.dependsOn ?? []) {
      if (dependency.type !== 'wrapper' || seen.has(dependency.id) || !packages[dependency.id]) {
        continue
      }
      seen.add(dependency.id)
      visit(dependency.id)
    }
  }
  visit(rootId)
  return seen
}

/** Installed packages that need a kept legacy record, as catalog install roots. */
function dependentRoots(
  packages: Readonly<Record<string, WrapperTreePackageState>>,
  keep: ReadonlySet<string>
): LegacyBundledRoot[] {
  return Object.entries(packages)
    .filter(([id, state]) => !isLegacyBundledWrapper(state) && !keep.has(id))
    .filter(([id]) => {
      const closure = dependencyClosure(packages, id)
      return [...keep].some((candidate) => closure.has(candidate))
    })
    .map(([id, state]) => ({ id, version: state.version }))
}

async function installFromOfficialCatalog(
  roots: LegacyBundledRoot[],
  agentDir: string,
  appVersion?: string
): Promise<void> {
  if (roots.length === 0) return
  // The signed release catalog keeps the family-package ids the legacy records used; the
  // website snapshot splits those families into per-module packages, so it cannot replace them.
  const registry = await syncOfficialRegistry({ agentDir })
  const options = { agentDir, ...(appVersion ? { appVersion } : {}) }
  for (const root of roots) {
    const request = { type: 'wrapper' as const, id: root.id, version: root.version }
    await prepareOfficialPackageInstall(registry, request, options)
    const plan = planInstall(registry, request, options)
    if (plan.packages.length > 0) await installPackages(plan, { agentDir })
  }
}

function clearChoices(ids: readonly string[], agentDir: string): void {
  if (ids.length === 0) return
  const state = readEnablementState({ agentDir })
  const keys = new Set(ids.map((id) => `wrapper:${id}`))
  const without = (values: Record<string, boolean>): Record<string, boolean> =>
    Object.fromEntries(Object.entries(values).filter(([key]) => !keys.has(key)))
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

function removeBundledMarker(agentDir: string): void {
  rmSync(join(agentDir, 'wrappers', 'bundled.json'), { force: true })
}
