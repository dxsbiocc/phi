import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  KernelClientError,
  type KernelProtocolClient,
  type SpawnedKernelClient
} from '../src/main/agent/engine/kernel-client'
import type { JsonValue, KernelEventFrame } from '../src/shared/kernel-protocol'
import { createKernelFixture, type KernelEngineFixture } from './engine-contract/kernel-factory'

function record(value: JsonValue): Record<string, JsonValue> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, JsonValue>
}

async function fixtureOrSkip(t: TestContext): Promise<KernelEngineFixture | undefined> {
  try {
    return await createKernelFixture()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM' || String(error).includes('EPERM')) {
      t.skip('sandbox forbids listening on 127.0.0.1')
      return undefined
    }
    throw error
  }
}

function trackCompletedRuns(client: KernelProtocolClient): {
  wait(runId: string): Promise<Record<string, JsonValue>>
  close(): void
} {
  const completed = new Map<string, Record<string, JsonValue>>()
  const waiters = new Map<string, (payload: Record<string, JsonValue>) => void>()
  const off = client.onEvent((event: KernelEventFrame) => {
    if (event.type !== 'run.completed') return
    const payload = record(event.payload)
    if (typeof payload.runId !== 'string') return
    completed.set(payload.runId, payload)
    waiters.get(payload.runId)?.(payload)
    waiters.delete(payload.runId)
  })
  return {
    wait(runId) {
      const existing = completed.get(runId)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(runId)
          reject(new Error(`Timed out waiting for run ${runId}`))
        }, 10_000)
        waiters.set(runId, (payload) => {
          clearTimeout(timeout)
          resolve(payload)
        })
      })
    },
    close: off
  }
}

test(
  'SIGKILL after acceptance recovers UNKNOWN once, rejects replay, and accepts a new run',
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fixtureOrSkip(t)
    if (!fixture) return
    let peer: SpawnedKernelClient | undefined
    try {
      await fixture.createSession('durable', { persistent: true, noTools: 'all' })
      const sessionId = fixture.kernelSessionId('durable')
      assert.ok(sessionId)
      fixture.provider.enqueue({ hold: true })
      const accepted = record(
        await fixture.client.request(
          'session.prompt',
          { text: 'hold before any tool', clientRunKey: 'crash-key' },
          { sessionId }
        )
      )
      assert.equal(typeof accepted.runId, 'string')
      // Kill only once the held model request is in flight; otherwise the held
      // reply stays queued and would stall the post-recovery prompt instead.
      const deadline = Date.now() + 10_000
      while (fixture.provider.requests.length < 1) {
        if (Date.now() > deadline) throw new Error('The held model request never arrived')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await fixture.kill()

      peer = await fixture.spawnPeer()
      assert.deepEqual(await peer.client.request('session.open', { sessionId }), { sessionId })
      assert.deepEqual(await peer.client.request('session.open', { sessionId }), { sessionId })
      const snapshot = record(await peer.client.request('session.snapshot', {}, { sessionId }))
      assert.deepEqual(snapshot.lastRun, { runId: accepted.runId, status: 'unknown' })
      const receipts = readFileSync(
        join(fixture.agentDir, 'phi-kernel', 'sessions', sessionId, 'runs.jsonl'),
        'utf8'
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      assert.equal(receipts.filter((receipt) => receipt.status === 'unknown').length, 1)

      await assert.rejects(
        peer.client.request(
          'session.prompt',
          { text: 'must not replay', clientRunKey: 'crash-key' },
          { sessionId }
        ),
        (error: unknown) =>
          error instanceof KernelClientError &&
          error.code === 'DUPLICATE_REQUEST' &&
          record(error.detail ?? null).runId === accepted.runId &&
          record(error.detail ?? null).status === 'unknown'
      )

      fixture.provider.enqueue({ text: 'recovered' })
      const runs = trackCompletedRuns(peer.client)
      const next = record(
        await peer.client.request(
          'session.prompt',
          { text: 'continue safely', clientRunKey: 'new-key' },
          { sessionId }
        )
      )
      assert.deepEqual(await runs.wait(String(next.runId)), {
        runId: next.runId,
        status: 'completed'
      })
      runs.close()
    } finally {
      await peer?.close()
      await fixture.close()
    }
  }
)

test(
  'two kernel processes race one open and hand ownership to the loser after close',
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fixtureOrSkip(t)
    if (!fixture) return
    const peers: SpawnedKernelClient[] = []
    try {
      await fixture.createSession('contended', { persistent: true, noTools: 'all' })
      const sessionId = fixture.kernelSessionId('contended')
      assert.ok(sessionId)
      await fixture.sessions.dispose({ sessionId: 'contended' })
      peers.push(await fixture.spawnPeer(), await fixture.spawnPeer())

      const results = await Promise.allSettled(
        peers.map((peer) => peer.client.request('session.open', { sessionId }))
      )
      const winnerIndex = results.findIndex((result) => result.status === 'fulfilled')
      const loserIndex = results.findIndex((result) => result.status === 'rejected')
      assert.notEqual(winnerIndex, -1)
      assert.notEqual(loserIndex, -1)
      const rejected = results[loserIndex]
      assert.equal(rejected.status, 'rejected')
      assert.ok(rejected.reason instanceof KernelClientError)
      assert.equal(rejected.reason.code, 'SESSION_BUSY')

      await peers[winnerIndex].client.request('session.close', {}, { sessionId })
      assert.deepEqual(await peers[loserIndex].client.request('session.open', { sessionId }), {
        sessionId
      })
    } finally {
      await Promise.allSettled(peers.map((peer) => peer.close()))
      await fixture.close()
    }
  }
)

test(
  'four persistent runs remain isolated and aborting one leaves the other three active',
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fixtureOrSkip(t)
    if (!fixture) return
    try {
      for (let index = 0; index < 4; index += 1) {
        await fixture.createSession(`parallel-${index}`, {
          persistent: true,
          noTools: 'all'
        })
      }
      fixture.provider.enqueue({ hold: true }, { hold: true }, { hold: true }, { hold: true })
      const sessionIds = Array.from({ length: 4 }, (_, index) => {
        const sessionId = fixture.kernelSessionId(`parallel-${index}`)
        assert.ok(sessionId)
        return sessionId
      })
      const accepted = await Promise.all(
        sessionIds.map((sessionId, index) =>
          fixture.client.request(
            'session.prompt',
            { text: `hold ${index}`, clientRunKey: `parallel-key-${index}` },
            { sessionId }
          )
        )
      )
      assert.equal(accepted.length, 4)
      await assert.rejects(
        fixture.client.request(
          'session.prompt',
          { text: 'second prompt', clientRunKey: 'different-key' },
          { sessionId: sessionIds[0] }
        ),
        (error: unknown) => error instanceof KernelClientError && error.code === 'SESSION_BUSY'
      )

      await fixture.client.request('session.abort', {}, { sessionId: sessionIds[0] })
      for (const sessionId of sessionIds.slice(1)) {
        const snapshot = record(await fixture.client.request('session.snapshot', {}, { sessionId }))
        assert.equal(typeof snapshot.activeRunId, 'string')
      }
    } finally {
      await fixture.close()
    }
  }
)
