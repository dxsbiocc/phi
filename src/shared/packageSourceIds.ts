/**
 * Registry ids used by payloads the app used to ship inside its own bundle. They are not
 * catalog installs: dependency planning must not treat them as installed, and choosing the
 * package in the catalog must install (and replace) the catalog copy.
 */
const LEGACY_PACKAGE_REGISTRY_IDS = new Set(['builtin', 'bundled-wrappers'])

export function isLegacyPackageRegistry(registry: string): boolean {
  return LEGACY_PACKAGE_REGISTRY_IDS.has(registry)
}
