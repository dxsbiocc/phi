import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRoutingEngine } from '../src/main/agent/engine/session-routing-engine'
import type { PhiEngine } from '../src/main/agent/engine/types'
import { beginRuntimeReferenceAdoption } from '../src/main/agent/session/session-store'
import {
  remoteReference,
  remoteReferenceScope,
  withRemoteReferenceSession
} from './helpers/sessionRuntimeReferenceFixture'

test('a project keeps listing its conversations after one of them ran remotely', async () => {
  await withRemoteReferenceSession(async (session) => {
    const lease = beginRuntimeReferenceAdoption(
      session.sessionId,
      remoteReferenceScope,
      'generation-1',
      {
        expectedOmpSessionId: 'omp-session-1',
        expectedJournalBasename: remoteReference(session.sessionId).journalBasename
      }
    )
    lease.adopt(remoteReference(session.sessionId))
    lease.release()
    const local = { path: '/agent/sessions/anchor/2026-10-15_local.jsonl', id: 'local' }
    const localHistoryEngine = {
      history: { list: async () => [local], open: async () => ({}) }
    } as unknown as PhiEngine
    const engine = new SessionRoutingEngine(localHistoryEngine, () => undefined)
    assert.deepEqual(await engine.history.list({ agentDir: '/agent', cwd: '/desktop/anchor' }), [
      local
    ])
  })
})
