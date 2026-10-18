import { wrapperCopy } from '../lib/wrapperCopy'
import { useEffect, useMemo, useState } from 'react'

import type { WrapperPackageMember } from '../../../../../shared/packageManagerTypes'
import type { WrapperCompositionCatalogItem } from '../../../../../shared/wrapperCompositionManifestTypes'
import type { WrapperCatalogChoice } from '../lib/wrapperCatalog'
import { wrapperPackageMembers } from '../lib/wrapperPackageDetail'

export interface WrapperPackageMembersState {
  status: 'loading' | 'ready' | 'error'
  wrappers: WrapperPackageMember[]
  /** Whether each member carries its own dag/meta files (read from the archive). */
  bundled: boolean
  /** Manifests in the package that could not be parsed. */
  skipped: number
  error?: string
}

interface RemoteResult {
  key: string
  wrappers: WrapperPackageMember[]
  skipped: number
  error?: string
}

/**
 * Wrappers already present locally come from the cached catalog; a package that only
 * exists in a registry is read on demand from its verified archive.
 */
export function useWrapperPackageMembers(
  catalog: readonly WrapperCompositionCatalogItem[],
  choice: WrapperCatalogChoice
): WrapperPackageMembersState {
  const local = useMemo(() => wrapperPackageMembers(catalog, choice.id), [catalog, choice.id])
  const [remote, setRemote] = useState<RemoteResult | null>(null)
  const registryPath = choice.registryPath
  const key = `${registryPath ?? ''}\n${choice.id}`

  useEffect(() => {
    if (local.length > 0 || !registryPath) return undefined
    let active = true
    window.api
      .readWrapperPackageDetail(registryPath, choice.id)
      .then((detail) => {
        if (active) setRemote({ key, wrappers: detail.wrappers, skipped: detail.skipped })
      })
      .catch((cause) => {
        if (active) {
          setRemote({
            key,
            wrappers: [],
            skipped: 0,
            error: cause instanceof Error ? cause.message : String(cause)
          })
        }
      })
    return () => {
      active = false
    }
  }, [local.length, registryPath, choice.id, key])

  if (local.length > 0) return { status: 'ready', wrappers: local, bundled: false, skipped: 0 }
  if (!registryPath) {
    return {
      status: 'error',
      wrappers: [],
      bundled: false,
      skipped: 0,
      error: wrapperCopy.noDetailSource
    }
  }
  if (!remote || remote.key !== key)
    return { status: 'loading', wrappers: [], bundled: false, skipped: 0 }
  return remote.error
    ? { status: 'error', wrappers: [], bundled: false, skipped: 0, error: remote.error }
    : { status: 'ready', wrappers: remote.wrappers, bundled: true, skipped: remote.skipped }
}
