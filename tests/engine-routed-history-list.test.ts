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

test('a remote conversation does not hide the other conversations of its project', async () => {
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
    const legacy = {
      history: {
        list: async () => [local],
        open: async () => ({})
      }
    } as unknown as PhiEngine
    const engine = new SessionRoutingEngine(legacy, () => undefined)
    assert.deepEqual(await engine.history.list({ agentDir: '/agent', cwd: '/desktop/anchor' }), [
      local
    ])
    await assert.rejects(
      engine.history.open({
        agentDir: '/agent',
        path: `phi-session:${session.sessionId}`,
        cwd: '/desktop/anchor'
      })
    )
  })
})
