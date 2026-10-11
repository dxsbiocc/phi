import {
  usePackageRemoval,
  type PackageRemoval
} from '../../../components/catalog/usePackageRemoval'

const removeWrapper = (id: string): Promise<unknown> => window.api.removeWrapperPackage(id)

/** Wrapper removal: bundled packages drop the user's choice, installed ones are uninstalled. */
export function useWrapperPackageRemoval(afterRemove: () => Promise<void> | void): PackageRemoval {
  return usePackageRemoval(removeWrapper, afterRemove)
}
