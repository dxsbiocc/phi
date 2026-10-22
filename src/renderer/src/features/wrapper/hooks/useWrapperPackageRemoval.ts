import {
  usePackageRemoval,
  type PackageRemoval
} from '../../../components/catalog/usePackageRemoval'

// Callers confirm the preview first; enabled dependents are then switched off together with it.
const removeWrapper = (id: string): Promise<unknown> =>
  window.api.removeWrapperPackage(id, { disableDependents: true })

/** Wrapper removal deletes the catalog-installed package and every file it owns. */
export function useWrapperPackageRemoval(
  afterRemove: () => Promise<void> | void,
  onError?: (message: string) => void
): PackageRemoval {
  return usePackageRemoval(removeWrapper, afterRemove, onError)
}
