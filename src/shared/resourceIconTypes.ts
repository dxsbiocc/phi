/** An opaque main-process registration key; never a renderer-provided path. */
export interface ResourceIconRef {
  key: string
}

/** Relative registry sidecar metadata covered by the registry index signature. */
export interface RegistryIconAsset {
  path: string
  sha256: string
  size: number
}

export const RESOURCE_ICON_MAX_BYTES = 256 * 1024
