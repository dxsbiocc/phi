import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import type { TeamResourceMap, TeamResourceSharing } from '../packages/installer-types'
import { packageKey } from '../packages/installer-utils'
import type { PackageType } from '../packages/manifest'
import { resolveSelections } from './admin-helpers'
import { materializeInstalledRegistry, materializeRegistryEntries } from './admin-registry'
import { resolvePendingSelections, type PendingSelection } from './admin-submissions'
import { isTeamPackError, teamPackError } from './errors'

const PREPARED_DIRECTORY = 'prepared-registries'

export interface TeamPackageSelection {
  type: PackageType
  id: string
  sharing?: TeamResourceSharing
  pendingSubmissionId?: string
}

export interface PreparedAdminRegistry {
  registryDir: string
  packages: Array<TeamPackageSelection & { version: string }>
  resources: TeamResourceMap
}

export function pendingSelectionsFromPackages(
  packages: readonly TeamPackageSelection[]
): PendingSelection[] {
  return packages.flatMap((selection) =>
    selection.pendingSubmissionId
      ? [
          {
            pendingSubmissionId: selection.pendingSubmissionId,
            type: selection.type,
            id: selection.id
          }
        ]
      : []
  )
}

export function materializeAdminSelections(options: {
  agentDir: string
  teamId: string
  teamDirectory: string
  selections: readonly TeamPackageSelection[]
  registryDir: string
  generatedAt: string
}): PreparedAdminRegistry {
  if (!Array.isArray(options.selections) || options.selections.length === 0) {
    throw teamPackError('INVALID_FORMAT', '团队发布至少需要选择一个资源')
  }
  const installedSelections = options.selections.filter(
    (selection) => !selection.pendingSubmissionId
  )
  const pendingSelections = pendingSelectionsFromPackages(options.selections)
  const selected =
    installedSelections.length > 0
      ? resolveSelections(options.agentDir, options.teamId, installedSelections)
      : []
  const intermediate = join(options.teamDirectory, PREPARED_DIRECTORY, `.installed-${randomUUID()}`)
  try {
    const installedRegistry =
      selected.length > 0
        ? materializeInstalledRegistry({
            agentDir: options.agentDir,
            teamId: options.teamId,
            installed: selected.map(({ installed }) => installed),
            registryDir: intermediate,
            generatedAt: options.generatedAt
          })
        : null
    const pending = resolvePendingSelections(options.teamDirectory, pendingSelections)
    const registry = materializeRegistryEntries({
      teamId: options.teamId,
      entries: [
        ...(installedRegistry
          ? installedRegistry.packages.map((entry) => ({ registry: installedRegistry, entry }))
          : []),
        ...pending.map(({ registry: source, entry }) => ({ registry: source, entry }))
      ],
      registryDir: options.registryDir,
      generatedAt: options.generatedAt
    })
    const packages = registry.packages.map(({ type, id, version }) => ({ type, id, version }))
    const resources = Object.fromEntries([
      ...selected.map(({ installed, resource }) => [packageKey(installed), resource] as const),
      ...pending.map(
        ({ entry, metadata }) =>
          [
            packageKey(entry),
            {
              sharing:
                options.selections.find(
                  (selection) =>
                    selection.pendingSubmissionId === metadata.submissionId &&
                    selection.type === entry.type &&
                    selection.id === entry.id
                )?.sharing ?? 'team-only'
            }
          ] as const
      )
    ])
    return { registryDir: options.registryDir, packages, resources }
  } catch (error) {
    rmSync(options.registryDir, { recursive: true, force: true })
    if (isTeamPackError(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw teamPackError('INVALID_FORMAT', `无法组装团队发布软件源: ${message}`, error)
  } finally {
    rmSync(intermediate, { recursive: true, force: true })
  }
}
