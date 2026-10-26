import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { discoverPhiAgents } from '../src/main/agent/agents/discovery'
import { KernelClientError } from '../src/main/agent/engine/kernel-client'
import type { JsonValue } from '../src/shared/kernel-protocol'
import { eventually } from './engine-contract/basic-suite'
import { createKernelFixture } from './engine-contract/kernel-factory'

for (const point of ['agent-accepted', 'agent-started'] as const) {
  test(
    `A08 real kernel restart makes ${point} child UNKNOWN once and rejects duplicate requestId`,
    { timeout: 45_000 },
    async (t) => {
      const f = await createKernelFixture({ testPause: point })
      t.after(() => f.close())
      await f.createSession(`a08-${point}`, { persistent: true, phiAgents: true })
      const sessionId = f.kernelSessionId(`a08-${point}`)!
      f.provider.enqueue({ text: 'This child must never be retried automatically.' })
      const starting = f.client.request(
        'agentRuns.start',
        {
          requestId: `request-${point}`,
          agent: 'PlanStep',
          task: 'Exercise the durable child-start crash boundary.'
        },
        { sessionId }
      )
      void starting.catch(() => undefined)
      const marker = join(f.agentDir, 'phi-kernel', `test-pause-${point}.marker`)
      await eventually(() => existsSync(marker), `${point} crash marker`)
      await f.kill()

      const peer = await f.spawnPeer()
      t.after(() => peer.close())
      const phiAgents = discoverPhiAgents({
        cwd: f.cwd,
        agentDir: f.agentDir,
        bundledDir: resolve('resources/agents'),
        pluginAgentDirs: [],
        homeDir: join(f.agentDir, '..', 'home')
      }).agents
      await peer.client.request('session.open', {
        sessionId,
        resources: { phiAgents: phiAgents as unknown as JsonValue }
      })
      const runs = (await peer.client.request(
        'agentRuns.list',
        {},
        { sessionId }
      )) as unknown as Array<{ requestId: string; state: string; runId?: string }>
      assert.equal(runs.length, 1)
      assert.equal(runs[0].requestId, `request-${point}`)
      assert.equal(runs[0].state, 'unknown')
      if (point === 'agent-started') assert.equal(typeof runs[0].runId, 'string')
      else assert.equal(runs[0].runId, undefined)

      await assert.rejects(
        peer.client.request(
          'agentRuns.start',
          {
            requestId: `request-${point}`,
            agent: 'PlanStep',
            task: 'A duplicate must not start.'
          },
          { sessionId }
        ),
        (error: unknown) => {
          assert.ok(error instanceof KernelClientError)
          assert.equal(error.code, 'DUPLICATE_REQUEST')
          assert.equal((error.detail as { state?: string })?.state, 'unknown')
          return true
        }
      )

      const receiptPath = join(f.agentDir, 'phi-kernel', 'sessions', sessionId, 'agent-runs.jsonl')
      const receipts = readFileSync(receiptPath, 'utf8').trim().split('\n')
      assert.equal(receipts.filter((line) => JSON.parse(line).state === 'terminal').length, 1)
    }
  )
}
