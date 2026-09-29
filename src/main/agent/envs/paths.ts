import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { getBundledResourceDir } from '../runtime/runtime-adapter'

// Phi platform id from process.platform and process.arch. Kept here so path
// lookup does not depend on the environment contract module.
const PHI_PLATFORM_IDS = ['darwin-arm64', 'darwin-x64', 'linux-x64'] as const

export type PhiPlatformId = (typeof PHI_PLATFORM_IDS)[number]

export function currentPhiPlatform(
  platform: string = process.platform,
  arch: string = process.arch
): PhiPlatformId | undefined {
  const id = `${platform}-${arch}`
  for (const supported of PHI_PLATFORM_IDS) {
    if (supported === id) return supported
  }
  return undefined
}

export function getMicromambaPath(platform: string | undefined = currentPhiPlatform()): string {
  if (!platform) {
    throw new Error(`micromamba is not bundled for ${process.platform}-${process.arch}`)
  }
  const binaryPath = join(getBundledResourceDir('runtime'), 'micromamba', platform, 'micromamba')
  if (!existsSync(binaryPath)) {
    throw new Error(
      `Bundled micromamba for ${platform} is missing at ${binaryPath}; run npm run runtime:fetch`
    )
  }
  return binaryPath
}
