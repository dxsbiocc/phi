/** Isolated R8 process: fresh private HOME and agent dir, real SSH, synthetic model. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createSshApplication } from './application'
import { productionBundleHash } from './bundle'
import { readPrivateJson } from './private-json'
import { executeR8 } from './runner'
import { openSshWorkspace } from './ssh-workspace'
import { assertInput, totalMsFor, type R8Input } from './types'

const input = (await readPrivateJson(process.argv[2])) as R8Input
assertInput(input)
assert.equal(process.env.HOME, join(input.localRoot, 'home'))
assert.equal(process.env.PI_CODING_AGENT_DIR, join(input.localRoot, 'agent'))

const controller = new AbortController()
const stop = (): void => controller.abort(new Error('R8 run cancelled'))
const timer = setTimeout(stop, totalMsFor(input.prepareMs))
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  const result = await executeR8(
    {
      identity: {
        runId: input.runId,
        host: input.host,
        runtimeRootConfigured: input.runtimeRoot,
        bundleHash: input.bundleHash
      },
      currentBundleHash: () => productionBundleHash(input.repoRoot),
      openWorkspace: (signal) => openSshWorkspace(input, signal),
      createApplication: (workspace) =>
        createSshApplication(input, workspace as Awaited<ReturnType<typeof openSshWorkspace>>)
    },
    controller
  )
  await writeFile(join(input.localRoot, 'result.json'), JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx'
  })
  console.log(JSON.stringify({ type: 'r8_result', ok: result.ok }))
  process.exitCode = result.ok ? 0 : 1
  // A handle that outlives the confirmed cleanup is itself a failure: never force-exit as success.
  setTimeout(() => {
    console.error('R8 process did not exit naturally after cleanup')
    process.exit(1)
  }, 30_000).unref()
} finally {
  clearTimeout(timer)
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
}
