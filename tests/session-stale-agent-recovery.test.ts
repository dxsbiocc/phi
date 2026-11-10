import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  appendSessionEvent,
  createPhiSession,
  createRunId,
  getSessionDir,
  listPhiSessions,
  readSessionEvents,
  recoverInterruptedPhiSessions,
  updateSessionManifest,
  type PhiSessionManifest
} from '../src/main/agent/session/session-store'
import {
  applyAgentBackgroundTimelineEvent,
  applyAgentCompletedTimelineEvent
} from '../src/renderer/src/lib/agentExecutionRestore'
import { runningAgentRuns } from '../src/renderer/src/lib/agentRunsOverview'
import {
  processingGroupStatus,
  type ProcessingItem
} from '../src/renderer/src/lib/chatRenderGroups'
import type { ChatItem } from '../src/renderer/src/types'

function withPhiDir<T>(callback: (phiDir: string) => T): T {
  const previous = process.env.PI_CODING_AGENT_DIR
  const phiDir = mkdtempSync(join(tmpdir(), 'phi-stale-agent-'))
  process.env.PI_CODING_AGENT_DIR = phiDir
  try {
    return callback(phiDir)
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = previous
    }
    rmSync(phiDir, { recursive: true, force: true })
  }
}

function createSession(): ReturnType<typeof createPhiSession> {
  return createPhiSession({
    kind: 'ordinary',
    cwd: '/workspace',
    cwdRealPath: '/workspace',
    permissionMode: 'auto'
  })
}

function manifestOf(sessionId: string): PhiSessionManifest {
  const manifest = listPhiSessions().find((entry) => entry.sessionId === sessionId)
  assert.ok(manifest, `missing manifest for ${sessionId}`)
  return manifest
}

function persistLegacyManifest(sessionDir: string): void {
  const path = join(sessionDir, 'manifest.json')
  const document = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  delete document.openAgentExecutions
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)
}

test('appendSessionEvent tracks open agent executions without duplicates', () => {
  withPhiDir(() => {
    const session = createSession()
    assert.equal(manifestOf(session.sessionId).openAgentExecutions, undefined)

    appendSessionEvent(session.sessionId, { type: 'user_message', content: 'delegate' })
    assert.equal(manifestOf(session.sessionId).openAgentExecutions, undefined)

    appendSessionEvent(session.sessionId, {
      type: 'agent_execution_started',
      toolCallId: 'call-1',
      runId: 'run-1',
      agentName: 'General'
    })
    appendSessionEvent(session.sessionId, {
      type: 'agent_execution_started',
      toolCallId: 'call-1',
      runId: 'run-1',
      agentName: 'General'
    })
    appendSessionEvent(session.sessionId, {
      type: 'agent_execution_started',
      toolCallId: 'call-2',
      runId: 'run-1',
      agentName: 'General'
    })
    assert.deepEqual(manifestOf(session.sessionId).openAgentExecutions, ['call-1', 'call-2'])

    appendSessionEvent(session.sessionId, {
      type: 'tool_call_started',
      toolCallId: 'call-3',
      toolName: 'read'
    })
    assert.deepEqual(manifestOf(session.sessionId).openAgentExecutions, ['call-1', 'call-2'])

    appendSessionEvent(session.sessionId, {
      type: 'agent_execution_completed',
      toolCallId: 'call-1',
      runId: 'run-1'
    })
    appendSessionEvent(session.sessionId, {
      type: 'agent_execution_completed',
      toolCallId: 'call-unknown',
      runId: 'run-1'
    })
    assert.deepEqual(manifestOf(session.sessionId).openAgentExecutions, ['call-2'])
  })
})

test('recovery closes a dangling agent card in an idle session', () => {
  withPhiDir(() => {
    const session = createSession()
    appendSessionEvent(session.sessionId, {
      type: 'agent_execution_started',
      toolCallId: 'native-task:CountAfterSleep',
      runId: createRunId(),
      agentName: 'General'
    })

    const [recovered] = recoverInterruptedPhiSessions()
    assert.equal(recovered.sessionId, session.sessionId)
    assert.deepEqual(recovered.openAgentExecutions, [])
    assert.equal(recovered.status, 'idle')

    const events = readSessionEvents(session.sessionId)
    assert.deepEqual(
      events.map((event) => event.type),
      ['agent_execution_started', 'agent_execution_completed']
    )
    const completed = events[1]
    assert.equal(completed.toolCallId, 'native-task:CountAfterSleep')
    assert.equal(completed.isError, true)
    assert.equal(completed.cancelled, true)
    assert.equal(completed.error, 'app_restarted')
  })
})

test('recovery closes agent cards before appending run_interrupted', () => {
  withPhiDir(() => {
    const session = createSession()
    const runId = createRunId()
    appendSessionEvent(session.sessionId, {
      type: 'agent_execution_started',
      toolCallId: 'call-1',
      runId,
      agentName: 'Wrapper'
    })
    updateSessionManifest(session.sessionId, {
      status: 'running',
      currentRunId: runId,
      currentRunStartedAt: '2026-11-01T00:00:00.000Z'
    })

    recoverInterruptedPhiSessions()

    const events = readSessionEvents(session.sessionId)
    assert.deepEqual(
      events.map((event) => event.type),
      ['agent_execution_started', 'agent_execution_completed', 'run_interrupted']
    )
    assert.equal(events[1].cancelled, true)
    assert.equal(events[1].error, 'app_restarted')
    assert.equal(events[2].runId, runId)
    assert.equal(manifestOf(session.sessionId).status, 'idle')
    assert.deepEqual(manifestOf(session.sessionId).openAgentExecutions, [])
  })
})

test('recovery leaves already completed agent cards untouched', () => {
  withPhiDir(() => {
    const session = createSession()
    appendSessionEvent(session.sessionId, {
      type: 'agent_execution_started',
      toolCallId: 'call-1',
      runId: 'run-1',
      agentName: 'General'
    })
    appendSessionEvent(session.sessionId, {
      type: 'agent_execution_completed',
      toolCallId: 'call-1',
      runId: 'run-1',
      agentName: 'General',
      isError: false
    })
    const before = readSessionEvents(session.sessionId)

    recoverInterruptedPhiSessions()

    assert.deepEqual(
      readSessionEvents(session.sessionId).map((event) => event.eventId),
      before.map((event) => event.eventId)
    )
    assert.deepEqual(manifestOf(session.sessionId).openAgentExecutions, [])
  })
})

test('legacy manifests are scanned once and then track an empty open set', () => {
  withPhiDir(() => {
    const session = createSession()
    const runId = createRunId()
    appendSessionEvent(session.sessionId, {
      type: 'agent_execution_started',
      toolCallId: 'call-1',
      runId,
      agentName: 'General'
    })
    persistLegacyManifest(session.dir)
    assert.equal(manifestOf(session.sessionId).openAgentExecutions, undefined)

    recoverInterruptedPhiSessions()

    const events = readSessionEvents(session.sessionId)
    const completed = events.find(
      (event) => event.type === 'agent_execution_completed' && event.toolCallId === 'call-1'
    )
    assert.ok(completed)
    assert.equal(completed.runId, runId)
    assert.equal(completed.agentName, 'General')
    assert.equal(completed.isError, true)
    assert.equal(completed.cancelled, true)
    assert.equal(completed.error, 'app_restarted')
    assert.deepEqual(manifestOf(session.sessionId).openAgentExecutions, [])

    const firstRecoveryCount = events.length
    recoverInterruptedPhiSessions()
    assert.equal(readSessionEvents(session.sessionId).length, firstRecoveryCount)
  })
})

test('a manifest with an open set is recovered without reading its history', () => {
  withPhiDir(() => {
    const session = createSession()
    updateSessionManifest(session.sessionId, { openAgentExecutions: ['call-1'] })
    writeFileSync(join(getSessionDir(session.sessionId), 'messages.jsonl'), 'not json\n')

    recoverInterruptedPhiSessions()

    const lines = readFileSync(join(getSessionDir(session.sessionId), 'messages.jsonl'), 'utf-8')
      .split('\n')
      .filter((line) => line.trim())
    assert.equal(lines.length, 2)
    const completed = JSON.parse(lines[1]) as Record<string, unknown>
    assert.equal(completed.type, 'agent_execution_completed')
    assert.equal(completed.toolCallId, 'call-1')
    assert.equal(completed.cancelled, true)
    assert.equal(completed.error, 'app_restarted')
    assert.deepEqual(manifestOf(session.sessionId).openAgentExecutions, [])
  })
})

test('a restored cancelled agent card stops the processing group', () => {
  const items: ChatItem[] = []
  applyAgentBackgroundTimelineEvent(items, {
    toolCallId: 'call-1',
    agentName: 'General',
    runId: 'run-1',
    createdAt: '2026-11-01T00:00:00.000Z'
  })
  applyAgentCompletedTimelineEvent(items, {
    toolCallId: 'call-1',
    agentName: 'General',
    isError: true,
    cancelled: true,
    error: 'app_restarted',
    createdAt: '2026-11-01T00:05:00.000Z'
  })

  const [card] = items
  assert.ok(card && card.role === 'agent_execution')
  assert.equal(card.status, 'error')
  assert.equal(card.cancelled, true)
  assert.equal(card.error, undefined)
  assert.deepEqual(runningAgentRuns(items, new Set()), [])
  assert.equal(processingGroupStatus(items as ProcessingItem[], false), null)
})

test('recovery keeps session ordering and leaves untouched manifests alone', () => {
  withPhiDir(() => {
    const session = createSession()
    appendSessionEvent(session.sessionId, {
      type: 'agent_execution_started',
      toolCallId: 'call-order',
      createdAt: '2026-11-07T08:14:13.844Z'
    })
    const before = manifestOf(session.sessionId)

    recoverInterruptedPhiSessions()
    const repaired = manifestOf(session.sessionId)
    assert.equal(repaired.lastActivityAt, before.lastActivityAt)
    const closing = readSessionEvents(session.sessionId).at(-1)
    assert.equal(closing?.createdAt, before.lastActivityAt)

    const manifestPath = join(session.dir, 'manifest.json')
    const settled = readFileSync(manifestPath, 'utf-8')
    recoverInterruptedPhiSessions()
    assert.equal(readFileSync(manifestPath, 'utf-8'), settled)
  })
})
