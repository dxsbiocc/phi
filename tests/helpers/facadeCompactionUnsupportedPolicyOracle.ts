import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { facadeMetadataFixture } from './facadeMetadataFixture'
import { findPhiSessionById } from '../../src/main/agent/session/session-store'

// The real readonly worker and app selector must reject unprojected model rules even
// when automatic maintenance is disabled and methods empty: manual still reads them.
await writeFile(
  join(process.env.PI_CODING_AGENT_DIR!, 'config.yml'),
  JSON.stringify({
    compaction: {
      enabled: false,
      thresholdPercent: 70,
      thresholdTokens: -1,
      methodOrder: [],
      modelThresholds: { 'phi-facade-regression/model-a': '90%' }
    }
  })
)
const f = await facadeMetadataFixture({ isolatedProject: true, applicationRouting: { agents: [] } })
try {
  await assert.rejects(f.createApplicationSession(), /does not yet support inherited per-model/)
  assert.equal(f.channels.length, 0, 'unsupported cold policy cannot start an OMP channel')
  assert.equal(f.provider.requests.length, 0)
  assert.equal(findPhiSessionById(f.phi.sessionId)!.runtimeRef, undefined)
  assert.equal(findPhiSessionById(f.phi.sessionId)!.autoCompaction, undefined)
} finally {
  await f.close()
}
