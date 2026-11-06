import assert from 'node:assert/strict'

import type { JsonValue } from '../../src/shared/kernel-protocol'
import { errorMessage, record, type ScenarioClient } from './harness'

type Step = <T>(name: string, action: () => Promise<T>) => Promise<T>

type ScriptedProvider = { enqueue(...replies: Array<{ text: string }>): void }

export interface ForkScenarioEvidence {
  sourceSessionId: string
  cutForkSessionId?: string
  wholeForkSessionId?: string
  cutForkError?: string
  wholeForkError?: string
}

async function fork(
  client: ScenarioClient,
  sessionId: string,
  params: Record<string, JsonValue>
): Promise<string> {
  const result = record(await client.client.request('session.fork', params, { sessionId }))
  const forked = result.sessionId
  assert.equal(typeof forked, 'string', `session.fork omitted sessionId: ${JSON.stringify(result)}`)
  assert.equal(typeof result.sessionFile, 'string', 'persistent fork omitted its journal')
  return forked as string
}

/**
 * Fork a persistent session the way the desktop does after two turns: from the first user
 * message (cut), then the whole history, then continue the cut fork.
 */
export async function runForkScenario(options: {
  provider: ScriptedProvider
  client: ScenarioClient
  projectRoot: string
  step: Step
}): Promise<ForkScenarioEvidence> {
  const first = '请只回复：分叉第一轮'
  const second = '请只回复：分叉第二轮'
  const sourceSessionId = await options.step('persistent source session created', () =>
    options.client.create(options.projectRoot, false, {
      sessionManager: { kind: 'persistent' } as JsonValue
    })
  )
  const evidence: ForkScenarioEvidence = { sourceSessionId }
  await options.step('source session completed two turns', async () => {
    for (const [text, reply] of [
      [first, 'FORK-ONE'],
      [second, 'FORK-TWO']
    ]) {
      options.provider.enqueue({ text: reply })
      const run = await options.client.prompt(sourceSessionId, text)
      assert.equal(run.status, 'completed', run.detail)
    }
  })

  try {
    evidence.cutForkSessionId = await options.step('fork from the first user message', () =>
      fork(options.client, sourceSessionId, {
        cut: { userMessages: [first, second], selectedIndex: 0 }
      })
    )
  } catch (error) {
    evidence.cutForkError = errorMessage(error)
  }
  try {
    evidence.wholeForkSessionId = await options.step('fork the whole history', () =>
      fork(options.client, sourceSessionId, {})
    )
  } catch (error) {
    evidence.wholeForkError = errorMessage(error)
  }

  if (evidence.cutForkSessionId) {
    const cutFork = evidence.cutForkSessionId
    await options.step('cut fork continues with only the first turn', async () => {
      options.provider.enqueue({ text: 'FORK-CONTINUED' })
      const run = await options.client.prompt(cutFork, '请只回复：分叉继续')
      assert.equal(run.status, 'completed', run.detail)
      const transcript = JSON.stringify(await options.client.snapshot(cutFork))
      assert.match(transcript, /分叉第一轮/)
      assert.doesNotMatch(transcript, /分叉第二轮/)
    })
  }
  return evidence
}
