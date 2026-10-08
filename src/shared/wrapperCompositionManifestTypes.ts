// The minimal per-wrapper manifest shape described in
// docs/design/phi-wrapper-agent-composition-design.md section 3 — a single
// `wrapper/wrapper.yaml` adapter beside a vendored nf-core module,
// subworkflow, or full pipeline under `resources/wrappers/`. This is the
// live schema the agent's composition discovery
// (`src/main/agent/wrappers/composition/discovery.ts`) actually parses;
// Package ownership and installation are represented separately by the
// package manifest and assembled-tree ownership map.
//
// Defined here (not only in `composition/manifest.ts`) so the renderer can
// share this exact shape via preload, the same way `wrapperManifestTypes.ts`
// is shared for the legacy catalog.

export interface WrapperCompositionParam {
  kind: 'input' | 'output' | 'option'
  type: string
  required: boolean
  description?: string
  minimum?: number
  maximum?: number
  /** Allowed values, when declared. */
  enum?: string[]
}

export interface WrapperCompositionOutput {
  type: string
  path: string
  primary: boolean
}

export interface WrapperCompositionManifest {
  id: string
  name: string
  summary: string
  params: Record<string, WrapperCompositionParam>
  outputs: Record<string, WrapperCompositionOutput>
}

/**
 * Renderer-facing discovery metadata. The wrapper contract remains the
 * manifest above; these fields describe the installed package that supplied
 * it and why it may be unavailable to the agent.
 */
export interface WrapperCompositionCatalogItem extends WrapperCompositionManifest {
  icon?: ResourceIconRef
  /** Absent for user-authored wrappers under wrappers/custom/. */
  packageId?: string
  /** Identifier used by wrapper:<id> enablement, including user-authored wrappers. */
  enablementId?: string
  /** False for untouched packages from the former automatic bundled installation. */
  packageSelected?: boolean
  /** The wrapper's resolved global or project enablement. */
  packageEnabled?: boolean
  /** Set when this wrapper is hidden from agent tools. */
  hiddenReason?: string
}
import type { ResourceIconRef } from './resourceIconTypes'
