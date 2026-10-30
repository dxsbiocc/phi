import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { CurrentSessionPayload } from '../src/main/agent/session/current-session-reads'
import {
  compactCurrentSession,
  type SessionCompactionControlOptions
} from '../src/main/agent/session/session-compaction-control'
import {
  createPhiSession,
  findPhiSessionById,
  readSessionEvents,
  recordKernelRuntimeReference
} from '../src/main/agent/session/session-store'
import { phiOnlySessionPath } from '../src/main/agent/session/sessions'

async function withPhiDir<T>(callback: (agentDir: string) => Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR
  const agentDir = realpathSync(mkdtempSync(join(tmpdir(), 'phi-session-compaction-control-')))
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    return await callback(agentDir)
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(agentDir, { recursive: true, force: true })
  }
}

test('manual compaction routes a live local kernel session and publishes its timeline notice', () =>
  withPhiDir(async (agentDir) => {
    const phi = createPhiSession({
      kind: 'ordinary',
      cwd: '/workspace',
      cwdRealPath: '/workspace',
      permissionMode: 'auto'
    })
    const manifest = recordKernelRuntimeReference(phi.sessionId, {
      kind: 'phi-kernel',
      version: 1,
      kernelSessionId: 'kernel-session',
      host: { kind: 'local', agentDir }
    })
    const sessionPath = phiOnlySessionPath(phi.sessionId)
    const current: CurrentSessionPayload = {
      path: sessionPath,
      phiSessionId: phi.sessionId,
      cwd: '/workspace',
      displayCwd: '/workspace',
      sessionGeneration: 4,
      permissionMode: 'auto',
      workMode: 'direct',
      status: 'idle',
      unreadKind: null
    }
    const manualCompactionIds = new Set<string>()
    const manualCompactionOperations = new Map<string, unknown>()
    const broadcasts: unknown[] = []
    const order: string[] = []
    let captureArgs: unknown[] | undefined
    let flushes = 0
    const routedSession = {
      compact: async (control?: { assertCurrent(): void }) => {
        order.push('compact')
        control?.assertCurrent()
        return {
          summary: 'Kernel history summary.',
          shortSummary: 'Kernel summary',
          tokensBefore: 12000,
          tokensAfter: 3000
        }
      }
    }
    const options: SessionCompactionControlOptions = {
      workspace: { agentDir },
      state: {
        getCurrentPayload: () => current,
        getCurrentSessionKey: () => sessionPath,
        getCurrentSessionPath: () => undefined,
        getCurrentCwd: () => current.cwd,
        getCurrentPermissionMode: () => current.permissionMode,
        manualCompactionIds,
        manualCompactionOperations: manualCompactionOperations as never
      },
      sessions: {
        findPhiManifestForSession: () => manifest,
        runtimeSessionPathForSnapshot: () => undefined,
        ensurePhiSessionId: () => phi.sessionId,
        hasActivePromptRun: () => false,
        captureSessionControlTarget: (...args) => {
          captureArgs = args
          return {
            current,
            rpc: true,
            assertCurrent: () => order.push('assert'),
            acceptManual: () => order.push('accept'),
            resolved: async () => ({ session: routedSession }) as never
          }
        },
        getSessionGeneration: () => current.sessionGeneration
      },
      events: {
        sendToAllWindows: (_channel, data) => broadcasts.push(data),
        notifySessionChanged: () => undefined,
        logUnexpectedError: (error) => assert.fail(String(error)),
        flushPendingContinuations: () => {
          flushes += 1
        }
      }
    }

    const outcome = await compactCurrentSession(
      {
        sessionPath,
        phiSessionId: phi.sessionId,
        sessionGeneration: current.sessionGeneration
      },
      options
    )

    assert.deepEqual(captureArgs, [sessionPath, phi.sessionId, true])
    assert.ok(order.indexOf('accept') < order.indexOf('compact'))
    assert.deepEqual(outcome, {
      sessionPath,
      phiSessionId: phi.sessionId,
      tokensBefore: 12000,
      tokensAfter: 3000,
      shortSummary: 'Kernel summary'
    })
    assert.equal(manualCompactionIds.size, 0)
    assert.equal(manualCompactionOperations.size, 0)
    assert.equal(flushes, 1)
    assert.equal(broadcasts.length, 1)
    assert.deepEqual(
      readSessionEvents(phi.sessionId).map((stored) => {
        const event: Record<string, unknown> = { ...stored }
        delete event.eventId
        delete event.sessionId
        delete event.createdAt
        return event
      }),
      [
        {
          type: 'context_compacted',
          action: 'manual',
          reason: 'user',
          summary: 'Kernel history summary.',
          shortSummary: 'Kernel summary',
          tokensBefore: 12000,
          tokensAfter: 3000
        }
      ]
    )
    assert.equal(
      findPhiSessionById(phi.sessionId)?.kernelRuntimeRef?.kernelSessionId,
      'kernel-session'
    )
  }))
