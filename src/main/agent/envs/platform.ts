/** Platforms Phi ships a runtime for, as `${process.platform}-${process.arch}`. */
export const PHI_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64'] as const
export type PhiPlatform = (typeof PHI_PLATFORMS)[number]

const CONDA_SUBDIR: Record<PhiPlatform, string> = {
  'darwin-arm64': 'osx-arm64',
  'darwin-x64': 'osx-64',
  'linux-x64': 'linux-64'
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
