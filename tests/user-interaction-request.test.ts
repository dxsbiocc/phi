import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import type { MissingToolPrompt } from '../src/shared/agentInteractionTypes'
import {
  resolveAgentUserInteraction,
  waitForAgentUserInteraction
} from '../src/main/agent/user-interaction'

function fakeWindow(): { window: never; sent: unknown[] } {
  const sent: unknown[] = []
  const webContents = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    send: (_channel: string, payload: unknown) => sent.push(payload)
  })
  const window = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false })
  return { window: window as never, sent }
}

test('a missing-tool prompt reaches the window, so the dedicated card renders', async () => {
  const { window, sent } = fakeWindow()
  const missingTool: MissingToolPrompt = {
    runtimeSessionId: 'runtime-1',
    tool: { id: 'nextflow', label: 'Nextflow' },
    candidates: [{ path: '/data/envs/nextflow/bin/nextflow', source: 'conda' }]
  }
  const pending = waitForAgentUserInteraction(
    {
      requestId: 'r1',
      questions: [{ header: 'Tool', question: 'Nextflow is required', options: [] }],
      missingTool
    },
    window
  )
  assert.deepEqual((sent[0] as { missingTool?: unknown }).missingTool, missingTool)
  resolveAgentUserInteraction('r1', { requestId: 'r1', answers: [] }, false, 7)
  assert.equal((await pending).cancelled, false)
})
