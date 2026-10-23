import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { SessionRoutingEngine } from '../src/main/agent/engine/session-routing-engine'
import type { PhiEngine } from '../src/main/agent/engine/types'
import {
  beginRuntimeReferenceAdoption,
  findPhiSessionById
} from '../src/main/agent/session/session-store'
import { isLegacyRemoteSession } from '../src/main/agent/session/legacy-remote-session'
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

test('an SSH manifest cannot create or resume a desktop in-process session', async () => {
  await withRemoteReferenceSession(async (session) => {
    let legacyCalls = 0
    const legacy = {
      sessions: {
        create: async () => {
          legacyCalls += 1
          return { sessionId: 'legacy', state: {} }
        }
      },
      history: {
        open: async () => {
          legacyCalls += 1
          return {}
        }
      }
    } as unknown as PhiEngine
    const engine = new SessionRoutingEngine(legacy, () => undefined)
    const base = {
      sessionId: 'desktop-runtime',
      agentDir: process.env.PI_CODING_AGENT_DIR!,
      cwd: session.manifest.cwd,
      sessionManager: { kind: 'memory' as const, cwd: session.manifest.cwd },
      enableToolApproval: false
    }

    await assert.rejects(engine.sessions.create(base), /远程会话.*history/)
    await assert.rejects(
      engine.sessions.create({
        ...base,
        sessionId: 'desktop-resume',
        cwd: '/unrelated-local-directory',
        sessionManager: {
          kind: 'open',
          cwd: '/unrelated-local-directory',
          path: `phi-session:${session.sessionId}`
        }
      }),
      /远程会话.*history/
    )
    await assert.rejects(
      engine.history.open({
        agentDir: process.env.PI_CODING_AGENT_DIR!,
        path: `phi-session:${session.sessionId}`,
        cwd: '/unrelated-local-directory'
      }),
      /远程会话.*history/
    )

    const manifestPath = join(session.dir, 'manifest.json')
    const damaged = JSON.parse(readFileSync(manifestPath, 'utf8'))
    damaged.runtimeRef = { kind: 'remote-omp', version: 999 }
    writeFileSync(manifestPath, JSON.stringify(damaged))
    const recoveryRequired = findPhiSessionById(session.sessionId)
    assert.equal(recoveryRequired?.runtimeRef, undefined)
    assert.ok(recoveryRequired?.runtimeRecoveryError)
    assert.equal(isLegacyRemoteSession(recoveryRequired), false)
    await assert.rejects(
      engine.sessions.create({
        ...base,
        sessionId: 'damaged-rpc-reference',
        cwd: '/unrelated-local-directory',
        sessionManager: {
          kind: 'open',
          cwd: '/unrelated-local-directory',
          path: `phi-session:${session.sessionId}`
        }
      }),
      /远程会话.*history/
    )
    assert.equal(legacyCalls, 0)
  })
})
