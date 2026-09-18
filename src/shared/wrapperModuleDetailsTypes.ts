// Curated subset of an nf-core module's own `meta.yml` and `environment.yml`
// — real upstream metadata that sits beside every module's `main.nf`, never
// duplicated into the lean `wrapper.yaml` contract (see
// `wrapperCompositionManifestTypes.ts`'s own header comment for why that
// one stays minimal). Surfaced separately, lazily, the same way
// `readWrapperCompositionDag` is: most of `meta.yml` (`input`/`output`/
// `topics` schema blocks, `containers`) is either redundant with what
// `wrapper.yaml`'s own `params`/`outputs` already show, or too low-level to
// be worth a viewer's attention — this keeps only the parts that answer
// "what is this tool, exactly, and which version does it pin."

export interface WrapperModuleTool {
  name: string
  description?: string
  homepage?: string
  documentation?: string
  licence?: string[]
  doi?: string
  identifier?: string
}

export interface WrapperModuleMeta {
  description?: string
  keywords?: string[]
  tools?: WrapperModuleTool[]
  authors?: string[]
}

export interface WrapperModuleDetails {
  meta?: WrapperModuleMeta
  /**
   * Raw `environment.yml` text, unmodified — shown verbatim as YAML rather
   * than parsed into fields, so whatever's actually in the file (not just a
   * `channels`/`dependencies` shape this app happened to expect) stays
   * visible.
   */
  environment?: string
}
