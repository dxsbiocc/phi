import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { errorMessage } from '../../../../shared/errorCodes'
import { parseWrapperCompositionManifest } from '../composition/manifest'

export interface InvalidWrapperPackage {
  path: string
  reason: string
}

export type InvalidWrapperPackageHandler = (invalid: InvalidWrapperPackage) => void

interface SourceWithDependencies {
  root: string
  manifest: {
    id: string
    dependsOn: Array<{ id: string }>
  }
}

interface EntryWithDependencies {
  id: string
  dependsOn: Array<{ id: string }>
}

export function filterInvalidWrapperAdapters(
  wrappersRoot: string,
  files: string[],
  onInvalidPackage?: InvalidWrapperPackageHandler
): string[] {
  const ids = new Map<string, string>()
  const invalidRoots = new Set<string>()
  for (const path of files.filter((candidate) => candidate.endsWith('/wrapper/wrapper.yaml'))) {
    try {
      const manifest = parseWrapperCompositionManifest(
        readFileSync(join(wrappersRoot, ...path.split('/')), 'utf8')
      )
      const previous = ids.get(manifest.id)
      if (previous) {
        throw new Error(`duplicate wrapper id '${manifest.id}' in '${previous}' and '${path}'`)
      }
      ids.set(manifest.id, path)
    } catch (error) {
      const reason = `invalid wrapper adapter '${path}': ${errorMessage(error)}`
      if (!onInvalidPackage) throw new Error(reason)
      const root = path.slice(0, -'/wrapper/wrapper.yaml'.length)
      invalidRoots.add(root)
      onInvalidPackage({ path: root, reason })
    }
  }
  return invalidRoots.size
    ? files.filter((path) => ![...invalidRoots].some((root) => path.startsWith(`${root}/`)))
    : files
}

export function dropInvalidSourceDependents<T extends SourceWithDependencies>(
  initial: T[],
  failedIds: Set<string>,
  onInvalidPackage?: InvalidWrapperPackageHandler
): T[] {
  let sources = initial
  while (failedIds.size > 0) {
    const dependent = sources.find((source) =>
      source.manifest.dependsOn.some((dependency) => failedIds.has(dependency.id))
    )
    if (!dependent) return sources
    const dependency = dependent.manifest.dependsOn.find((item) => failedIds.has(item.id))!
    failedIds.add(dependent.manifest.id)
    onInvalidPackage?.({
      path: dependent.root,
      reason: `wrapper package '${dependent.manifest.id}' depends on skipped package '${dependency.id}'`
    })
    sources = sources.filter((source) => source.manifest.id !== dependent.manifest.id)
  }
  return sources
}

export function dropInvalidEntryDependents<T extends EntryWithDependencies>(
  initial: T[],
  failedIds: Set<string>,
  roots: Map<string, string>,
  onInvalidPackage?: InvalidWrapperPackageHandler
): T[] {
  let entries = initial
  while (failedIds.size > 0) {
    const dependent = entries.find((entry) =>
      entry.dependsOn.some((dependency) => failedIds.has(dependency.id))
    )
    if (!dependent) return entries
    const dependency = dependent.dependsOn.find((item) => failedIds.has(item.id))!
    failedIds.add(dependent.id)
    onInvalidPackage?.({
      path: roots.get(dependent.id) ?? dependent.id,
      reason: `wrapper package '${dependent.id}' depends on skipped package '${dependency.id}'`
    })
    entries = entries.filter((entry) => entry.id !== dependent.id)
  }
  return entries
}
