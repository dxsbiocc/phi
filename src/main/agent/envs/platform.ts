/** Platforms Phi ships a runtime for, as `${process.platform}-${process.arch}`. */
export const PHI_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'] as const
export type PhiPlatform = (typeof PHI_PLATFORMS)[number]

/**
 * Platforms that skill and plugin validation require locks for.
 * `win32-x64` is a runtime platform; official `phi-jupyter` and `phi-python`
 * ship Windows locks. `phi-r` and `phi-nextflow` still cannot solve on win-64
 * (bioconda / Unix-only packages) and fall back to WSL2.
 */
export const PHI_LOCK_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64'] as const
export type PhiLockPlatform = (typeof PHI_LOCK_PLATFORMS)[number]

const CONDA_SUBDIR: Record<PhiPlatform, string> = {
  'darwin-arm64': 'osx-arm64',
  'darwin-x64': 'osx-64',
  'linux-x64': 'linux-64',
  'win32-x64': 'win-64'
}

export function condaSubdir(platform: PhiPlatform): string {
  return CONDA_SUBDIR[platform]
}

/** The Phi platform for this host, or undefined when Phi ships no runtime for it. */
export function findPlatform(
  platform: string = process.platform,
  arch: string = process.arch
): PhiPlatform | undefined {
  const id = `${platform}-${arch}`
  return PHI_PLATFORMS.find((supported) => supported === id)
}

export function currentPlatform(
  platform: string = process.platform,
  arch: string = process.arch
): PhiPlatform {
  const found = findPlatform(platform, arch)
  if (!found) throw new Error(`unsupported platform: ${platform}-${arch}`)
  return found
}

export type ManagedLockResolution = {
  platform: PhiPlatform
  runtime: 'native' | 'wsl2'
}

/**
 * Windows hosts without a native lock still build official Linux environments
 * through WSL2. Callers pass whether each lock file exists.
 */
export function resolveManagedLockPlatform(
  hostPlatform: PhiPlatform,
  hasLock: (platform: PhiPlatform) => boolean
): ManagedLockResolution | undefined {
  if (hasLock(hostPlatform)) return { platform: hostPlatform, runtime: 'native' }
  if (hostPlatform === 'win32-x64' && hasLock('linux-x64')) {
    return { platform: 'linux-x64', runtime: 'wsl2' }
  }
  return undefined
}
