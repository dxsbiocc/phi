import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { getBundledResourceDir } from '../runtime/runtime-adapter'
import { findPlatform } from './platform'

export function getMicromambaPath(platform: string | undefined = findPlatform()): string {
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
