import type { WrapperManifest } from './wrapperManifestTypes'
import type { WrapperTrustTier } from './wrapperTypes'
import type { ResourceIconRef } from './resourceIconTypes'

/**
 * One installed wrapper (bundled or custom) as shown in the Wrappers
 * sidebar and used to resolve a wrapper for plan creation. Shared with the
 * renderer (via preload) so the sidebar can render manifest detail and the
 * `WrapperFlowDiagram` structure view without a second, main-process-only
 * type. See src/main/agent/wrappers/catalog.ts for how these get produced.
 */
export interface WrapperCatalogEntry {
  icon?: ResourceIconRef
  manifest: WrapperManifest
  trustTier: WrapperTrustTier
  /** Directory under `~/.phi/wrappers/installed` holding this wrapper's files. */
  installedPath: string
  installedAt: string
}
