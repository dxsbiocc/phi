import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createPhiExtensionBundle,
  type PhiExtensionBundle,
  type ExtensionDeploymentOptions
} from '../../src/main/agent/engine/rpc/extension-deployment'
import { createRemoteOmpDeploymentFixture } from './remoteOmpDeploymentFixture'
import { createLocalShellSession } from './localShellSession'
import { installFlockShim } from './flockShim'

export async function createPhiExtensionDeploymentFixture(payload?: string): Promise<
  Awaited<ReturnType<typeof createRemoteOmpDeploymentFixture>> & {
    sourceRoot: string
    bundle: PhiExtensionBundle
    deploymentOptions: ExtensionDeploymentOptions
  }
> {
  const fixture = await createRemoteOmpDeploymentFixture(payload)
  const restoreFlock = installFlockShim(join(fixture.root, 'flock-shim'))
  const lockSession = createLocalShellSession(fixture.runtimeRoot)
  const sourceRoot = join(fixture.root, 'extension-source')
  await mkdir(join(sourceRoot, 'lib'), { recursive: true })
  await writeFile(
    join(sourceRoot, 'rpc-entry.ts'),
    "import { guard } from './lib/guard'\nexport default guard\n"
  )
  await writeFile(join(sourceRoot, 'lib/guard.ts'), 'export const guard = () => undefined\n')
  const bundle = await createPhiExtensionBundle(sourceRoot)
  return {
    ...fixture,
    cleanup: async () => {
      await lockSession.close()
      restoreFlock()
      await fixture.cleanup()
    },
    sourceRoot,
    bundle,
    deploymentOptions: {
      runtimeHost: fixture.host,
      runtimeRoot: fixture.runtimeRoot,
      cacheDir: fixture.options.cacheDir,
      openLockStdio: (command) => lockSession.openStdio!(command),
      bundle,
      uploadOptions: fixture.options.uploadOptions
    }
  }
}
