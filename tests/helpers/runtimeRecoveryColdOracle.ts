import { join } from 'node:path'
import { readManifestFile } from '../../src/main/agent/session/manifest-file'
import { resolveRuntimeSessionOrigin } from '../../src/main/agent/session/runtime-origin-store'
import { readColdChildRuns } from '../../src/main/agent/session/child-run-recovery'

const agentDir = process.argv[2]
if (!agentDir) throw new Error('Missing isolated store')
const manifest = readManifestFile(join(agentDir, 'manifest.json'), 'phi')
const reference = manifest.runtimeRef
if (!reference) throw new Error('Missing verified reference')
const scope = {
  hostProfileId: reference.hostProfileId,
  bindingHash: reference.bindingHash,
  projectId: reference.projectId,
  projectRoot: reference.projectRoot,
  runtimeRoot: reference.runtimeRoot
}
const origin = resolveRuntimeSessionOrigin(
  'old-runtime',
  {
    readManifest: () => manifest,
    resolveRemoteScope: () => scope,
    resolveConfiguredRuntimeRoot: () => null
  },
  agentDir
)
const children = readColdChildRuns({ phiSessionId: 'phi', reference }, agentDir)
process.stdout.write(
  JSON.stringify({
    origin,
    children: children.map(({ id, status, canControl, historyAvailable }) => ({
      id,
      status,
      canControl,
      historyAvailable
    }))
  })
)
