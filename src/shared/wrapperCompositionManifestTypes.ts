// The minimal per-wrapper manifest shape described in
// docs/design/phi-wrapper-agent-composition-design.md section 3 — a single
// `wrapper/wrapper.yaml` adapter beside a vendored nf-core module,
// subworkflow, or full pipeline under `resources/wrappers/`. This is the
// live schema the agent's composition discovery
// (`src/main/agent/wrappers/composition/discovery.ts`) actually parses;
// it supersedes the older, fuller `WrapperManifest`
// (`wrapperManifestTypes.ts`), which described a separately-versioned,
// installable wrapper package that the composition layout replaced.
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
