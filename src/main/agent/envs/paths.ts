import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { getBundledResourceDir } from '../runtime/runtime-adapter'
import { findPlatform } from './platform'

/** Packaged extraResources path first, then the repository bundle used in development. */
export function micromambaCandidates(
  platform: string,
  options: { resourcesPath?: string; bundledRuntimeDir: string }
): string[] {
  const bundledPath = join(options.bundledRuntimeDir, 'micromamba', platform, 'micromamba')
  if (typeof options.resourcesPath !== 'string') return [bundledPath]
  return [join(options.resourcesPath, 'runtime', 'micromamba', platform, 'micromamba'), bundledPath]
}

export function getMicromambaPath(platform: string | undefined = findPlatform()): string {
  if (!platform) {
    throw new Error(`micromamba is not bundled for ${process.platform}-${process.arch}`)
  }
  const resourcesPath = process.resourcesPath
  const candidates = micromambaCandidates(platform, {
    resourcesPath: typeof resourcesPath === 'string' ? resourcesPath : undefined,
    bundledRuntimeDir: getBundledResourceDir('runtime')
  })
  const binaryPath = candidates.find((candidate) => existsSync(candidate))
  if (!binaryPath) {
    const missingPath = candidates[candidates.length - 1]
    throw new Error(
      `Bundled micromamba for ${platform} is missing at ${missingPath}; run npm run runtime:fetch`
    )
  }
  return binaryPath
}
