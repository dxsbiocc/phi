import assert from 'node:assert/strict'
import test from 'node:test'

import type { JsonValue } from '../src/shared/kernel-protocol'
import { bindWorkerOutbound } from '../src/kernel/worker/outbound'
import { requestHost } from '../src/main/agent/engine/in-process/ipc'

function bindWithActiveRun(activeRun: string | undefined) {
  const contexts: unknown[] = []
  const unbind = bindWorkerOutbound({
    agentDir: '/trusted/agent',
    core: {
      async requestHost(_capability: string, _params: JsonValue, context: unknown) {
        contexts.push(context)
        return { ok: true }
      }
    } as never,
    activeRunId: () => activeRun,
    persistentSession: () => undefined,
    projectSessionState: () => null,
    diagnoseDroppedEvent: () => undefined,
    rejectAuthPrompt: () => undefined
  })
  return { contexts, unbind }
}

test('a child of a live prompt keeps the prompt run binding', async () => {
  const { contexts, unbind } = bindWithActiveRun('prompt-run')
  try {
    await requestHost('skills.scriptTool', { tool: 'viz_catalog' }, {
      originSessionId: 'session-1',
      agentRunId: 'child-run'
    })
    assert.deepEqual(contexts, [
      { sessionId: 'session-1', runId: 'prompt-run', agentRunId: 'child-run' }
    ])
  } finally {
    unbind()
  }
})

test('a child without a live prompt run binds its own run id', async () => {
  const { contexts, unbind } = bindWithActiveRun(undefined)
  try {
    await requestHost('skills.scriptTool', { tool: 'viz_catalog' }, {
      originSessionId: 'session-1',
      agentRunId: 'child-run'
    })
    assert.deepEqual(contexts, [
      { sessionId: 'session-1', runId: 'child-run', agentRunId: 'child-run' }
    ])
  } finally {
    unbind()
  }
})
