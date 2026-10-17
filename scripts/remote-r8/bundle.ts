import {
  createPhiExtensionBundle,
  resolvePhiExtensionSourceRoot
} from '../../src/main/agent/engine/rpc/extension-deployment'

/**
 * The extension bundle hash exactly as production computes it for a non-packaged app:
 * the same source-root resolution and bundler the startup uses.
 */
export async function productionBundleHash(repoRoot: string): Promise<string> {
  const sourceRoot = resolvePhiExtensionSourceRoot({
    appPath: repoRoot,
    resourcesPath: `${repoRoot}/resources`,
    isPackaged: false
  })
  return (await createPhiExtensionBundle(sourceRoot)).contentHash
}
