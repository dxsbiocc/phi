import type { PhiPlatform } from '../platform'

export interface PythonUvInstallation {
  backend: 'python-uv'
  requirements: string
  requirementsSha256: string
  executable: string
}

export interface JavaScriptBunInstallation {
  backend: 'javascript-bun'
  manifest: './package.json'
  manifestSha256: string
  lock: './bun.lock' | './package-lock.json'
  lockSha256: string
  executable: string
  /** Bun installs the application; Node is an explicit managed execution override. */
  runtime?: 'bun' | 'node'
  bun?: PinnedRuntimeTool
  node?: PinnedRuntimeTool
}

export type NativeApplicationArtifact = {
  url: string
  sha256: string
  size: number
} & ({ format: 'file'; member?: never } | { format: 'tar.gz' | 'zip'; member: string })

export interface PinnedRuntimeTool {
  version: string
  artifacts: Partial<Record<PhiPlatform, NativeApplicationArtifact>>
}

export interface NativeInstallation {
  backend: 'native'
  executable: string
  artifacts: Partial<Record<PhiPlatform, NativeApplicationArtifact>>
}

export type ApplicationInstallation =
  PythonUvInstallation | JavaScriptBunInstallation | NativeInstallation

export interface ApplicationInstallProgress {
  phase: string
  message: string
}

export interface ApplicationInstallInput {
  root: string
  prefix: string
  sourceDir: string
  platform: PhiPlatform
  installation: ApplicationInstallation
  signal?: AbortSignal
  onProgress?: (event: ApplicationInstallProgress) => void
  fetch?: typeof globalThis.fetch
}

export interface ApplicationInstallationMetadata {
  backend: ApplicationInstallation['backend']
  executable: string
  specSha256: string
  artifacts: Array<{ key: string; sha256: string; size: number }>
  packages?: Array<{ name: string; version: string }>
  installer?: { name: 'bun' | 'uv'; version: string }
}

export type ApplicationInstallResult = ApplicationInstallationMetadata
export type ApplicationInstallationProvider = (
  input: ApplicationInstallInput
) => Promise<ApplicationInstallResult>
