import { randomUUID } from 'node:crypto'

import { productionBundleHash } from '../../scripts/remote-r8/bundle'
import { executeR8 } from '../../scripts/remote-r8/runner'
import { createLocalR8 } from './remoteR8Local'

const RESULT_PREFIX = 'R8_LOCAL_RESULT '
const runId = `r8-${randomUUID()}`
const bundleHash = await productionBundleHash(process.cwd())
const local = await createLocalR8(runId, bundleHash)

let primary: unknown
try {
  const result = await executeR8(
    {
      identity: {
        runId,
        host: 'synthetic-no-ssh',
        runtimeRootConfigured: local.workspace.runtimeRoot,
        bundleHash
      },
      currentBundleHash: () => productionBundleHash(process.cwd()),
      openWorkspace: async () => local.workspace,
      createApplication: async () => local.application
    },
    new AbortController()
  )
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`)
} catch (error) {
  primary = error
  throw error
} finally {
  await local.fixture.f.cleanup().catch((error) => {
    if (!primary) throw error
  })
}
