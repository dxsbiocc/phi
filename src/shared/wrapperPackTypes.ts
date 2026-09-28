/** Where the active wrapper pack came from — see `src/main/agent/wrappers/composition/packs.ts`. */
export type WrapperPackSource = 'bundled' | 'overlay'

/** The wrapper pack the composition layer is running from. */
export interface ActiveWrapperPack {
  /** Pack root: the directory holding `pack.json`, `modules/`, `subworkflows/`, `workflows/`. */
  root: string
  name: string
  version: string
  source: WrapperPackSource
  /** sha256 content digest from `index.json`; absent for a bundled pack in a dev checkout. */
  digest?: string
}

/** An overlay pack that was found but not used. */
export interface RejectedWrapperPack {
  root: string
  reason: string
}

/** The pack a run executed from, recorded on the run for reproducibility. */
export type WrapperRunPack = Omit<ActiveWrapperPack, 'root'>
