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

test(
  'real kernel declines a specialist that twice reports a missing artifact without using tools',
  { timeout: 45_000 },
  async (t) => {
    const fixture = await createKernelFixture()
    t.after(() => fixture.close())
    await fixture.createSession('research-evidence', { persistent: true, phiAgents: true })
    const sessionId = fixture.kernelSessionId('research-evidence')!
    const original = 'Which genes changed in the comparison?'
    const fabricated =
      '<phi_agent_result>' +
      JSON.stringify({
        status: 'completed',
        research: {
          subquestion: original,
          answer: 'UNVERIFIED_123_45',
          interpretation: 'Invented result',
          rationale: 'Invented rationale',
          evidence: ['results/de.tsv']
        }
      }) +
      '</phi_agent_result>'
    fixture.provider.enqueue({ text: fabricated })
    fixture.provider.enqueue({ text: fabricated })
    const started = (await fixture.client.request(
      'agentRuns.start',
      {
        requestId: 'unverified-evidence',
        agent: 'PlanStep',
        task: 'Perform the comparison.',
        researchQuestion: original
      },
      { sessionId }
    )) as { runId: string }
    const waited = await fixture.client.request(
      'agentRuns.wait',
      {
        runId: started.runId,
        timeoutMs: 20_000
      },
      { sessionId }
    )
    assert.equal(fixture.provider.requests.length, 2, 'Exactly one in-child correction was issued')
    assert.match(JSON.stringify(fixture.provider.requests[1].messages), /actual authorized tools/)
    assert.match(JSON.stringify(waited), /Insufficient evidence/)
    assert.doesNotMatch(JSON.stringify(waited), /UNVERIFIED_123_45/)
    const receipts = readFileSync(
      join(fixture.agentDir, 'phi-kernel', 'sessions', sessionId, 'agent-runs.jsonl'),
      'utf8'
    )
    assert.match(receipts, /Insufficient evidence/)
    assert.doesNotMatch(receipts, /UNVERIFIED_123_45/)
  }
)
