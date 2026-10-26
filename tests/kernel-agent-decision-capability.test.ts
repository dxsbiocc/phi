import assert from 'node:assert/strict'
import test from 'node:test'

import type { TaskRoutingAssessor } from '../src/main/agent/decisions/policies'
import { sessionAgentAssessment } from '../src/main/agent/engine/in-process/session-agent-tools'

const assessor: TaskRoutingAssessor = async () => ({
  choice: 'suitable',
  source: 'model',
  model: { providerId: 'fake', modelId: 'model' },
  fallbackReason: 'not_configured'
})

test('kernel delegation remains callable when the desktop omitted decisions.evaluate', () => {
  assert.equal(
    sessionAgentAssessment({
      desktopServices: true,
      hostCapabilities: [],
      assessTask: assessor
    }),
    undefined
  )
  assert.equal(
    sessionAgentAssessment({
      desktopServices: true,
      hostCapabilities: ['decisions.evaluate'],
      assessTask: assessor
    }),
    assessor
  )
  assert.equal(
    sessionAgentAssessment({
      desktopServices: false,
      hostCapabilities: [],
      assessTask: assessor
    }),
    assessor
  )
})
