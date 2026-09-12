import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  appendSessionEvent,
  createPhiSession,
  createRunId,
  getSessionDir,
  listPhiSessions,
  persistToolOutput,
  readSessionEvents,
  recoverInterruptedPhiSessions,
  updateSessionManifest
} from '../src/main/agent/session/session-store'

function withPhiDir<T>(callback: (phiDir: string) => T): T {
  const previous = process.env.PI_CODING_AGENT_DIR
  const phiDir = mkdtempSync(join(tmpdir(), 'phi-session-store-'))
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

test('createPhiSession creates a stable session directory and manifest', () => {
  withPhiDir((phiDir) => {
    const session = createPhiSession({
      kind: 'project',
      projectId: 'project-1',
      cwd: '/display/project',
      cwdRealPath: '/real/project',
      title: 'Project task',
      permissionMode: 'ask',
      model: { providerId: 'openai', modelId: 'gpt-test' },
      thinkingLevel: 'high'
    })

    assert.match(session.sessionId, /^[0-9a-f-]{36}$/)
    assert.equal(session.manifest.schemaVersion, 1)
    assert.equal(session.manifest.status, 'idle')
    assert.equal(session.manifest.unreadKind, null)
    assert.equal(session.manifest.kind, 'project')
    assert.equal(session.manifest.projectId, 'project-1')
    assert.equal(session.manifest.cwd, '/display/project')
    assert.equal(session.manifest.cwdRealPath, '/real/project')
    assert.deepEqual(session.manifest.model, { providerId: 'openai', modelId: 'gpt-test' })
    assert.equal(session.manifest.thinkingLevel, 'high')
    assert.equal(getSessionDir(session.sessionId), join(phiDir, 'sessions', session.sessionId))
    assert.equal(existsSync(join(session.dir, 'tool-outputs')), true)
    assert.equal(existsSync(join(session.dir, 'artifacts')), true)

    const rawManifest = JSON.parse(
      readFileSync(join(session.dir, 'manifest.json'), 'utf-8')
    ) as typeof session.manifest
    assert.equal(rawManifest.sessionId, session.sessionId)
  })
})

test('persistToolOutput keeps short output inline and stores long output as a local file', () => {
  withPhiDir(() => {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: '/workspace',
      cwdRealPath: '/workspace',
      permissionMode: 'auto'
    })

    const inline = persistToolOutput(session.sessionId, {
      runId: 'run-1',
      toolCallId: 'tool-1',
      output: 'short',
      inlineLimit: 10
    })
    assert.deepEqual(inline, {
      outputPreview: 'short',
      outputBytes: 5,
      truncated: false
    })

    const long = persistToolOutput(session.sessionId, {
      runId: 'run/1',
      toolCallId: 'tool:1',
      output: 'abcdefghijklmnop',
      inlineLimit: 8
    })

    assert.equal(long.truncated, true)
    assert.equal(long.outputBytes, 16)
    assert.match(long.outputPreview, /^abcdefgh\n\.\.\.（完整输出已保存到 /)
    assert.ok(long.outputPath)
    assert.equal(readFileSync(long.outputPath, 'utf-8'), 'abcdefghijklmnop')
    assert.equal(long.outputPath.endsWith('/tool-outputs/run_1-tool_1.txt'), true)
    assert.deepEqual(long.outputArtifact, {
      kind: 'tool_output',
      path: long.outputPath,
      bytes: 16
    })
  })
})

test('appendSessionEvent appends jsonl and updates manifest activity summary', () => {
  withPhiDir(() => {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: '/home/user/.phi/workspace',
      cwdRealPath: '/home/user/.phi/workspace',
      permissionMode: 'auto'
    })
    const runId = createRunId()

    const userEvent = appendSessionEvent(session.sessionId, {
      type: 'user_message',
      runId,
      content: 'hello'
    })
    const assistantEvent = appendSessionEvent(session.sessionId, {
      type: 'assistant_message_finalized',
      runId,
      content: 'done'
    })

    assert.equal(userEvent.sessionId, session.sessionId)
    assert.equal(assistantEvent.runId, runId)
    assert.notEqual(userEvent.eventId, assistantEvent.eventId)

    const events = readSessionEvents(session.sessionId)
    assert.deepEqual(
      events.map((event) => event.type),
      ['user_message', 'assistant_message_finalized']
    )

    const [listed] = listPhiSessions()
    assert.equal(listed.sessionId, session.sessionId)
    assert.equal(listed.messageCount, 2)
    assert.equal(listed.lastEventType, 'assistant_message_finalized')
  })
})

test('appendSessionEvent preserves event timestamps in stored history', () => {
  withPhiDir(() => {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: '/workspace',
      cwdRealPath: '/workspace',
      permissionMode: 'auto'
    })

    const event = appendSessionEvent(session.sessionId, {
      type: 'tool_call_started',
      runId: 'run-1',
      toolCallId: 'tool-1',
      createdAt: '2026-09-07T00:00:05.000Z'
    })

    assert.equal(event.createdAt, '2026-09-07T00:00:05.000Z')
    assert.equal(readSessionEvents(session.sessionId)[0].createdAt, '2026-09-07T00:00:05.000Z')
    assert.equal(listPhiSessions()[0].lastActivityAt, '2026-09-07T00:00:05.000Z')
  })
})

test('updateSessionManifest stores stable state without rewriting events', () => {
  withPhiDir(() => {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: '/workspace',
      cwdRealPath: '/workspace',
      permissionMode: 'auto'
    })
    appendSessionEvent(session.sessionId, { type: 'run_started', runId: createRunId() })
    const before = readFileSync(join(session.dir, 'messages.jsonl'), 'utf-8')

    const updated = updateSessionManifest(session.sessionId, {
      status: 'completed_unread',
      unreadKind: 'completed',
      lastRunOutcome: 'completed'
    })

    assert.equal(updated.status, 'completed_unread')
    assert.equal(updated.unreadKind, 'completed')
    assert.equal(updated.lastRunOutcome, 'completed')
    assert.equal(readFileSync(join(session.dir, 'messages.jsonl'), 'utf-8'), before)
  })
})

test('recoverInterruptedPhiSessions recovers stale active sessions after restart once', () => {
  withPhiDir(() => {
    const session = createPhiSession({
      kind: 'project',
      projectId: 'project-1',
      cwd: '/workspace/project',
      cwdRealPath: '/workspace/project',
      permissionMode: 'ask'
    })
    const runId = createRunId()
    updateSessionManifest(session.sessionId, {
      status: 'needs_approval',
      unreadKind: 'approval',
      currentRunId: runId,
      currentRunStartedAt: '2026-09-05T10:00:00.000Z'
    })

    const [recovered] = recoverInterruptedPhiSessions()

    assert.equal(recovered.status, 'idle')
    assert.equal(recovered.unreadKind, null)
    assert.equal(recovered.currentRunId, undefined)
    assert.equal(recovered.currentRunStartedAt, undefined)
    assert.equal(recovered.lastRunOutcome, 'interrupted')
    assert.deepEqual(
      readSessionEvents(session.sessionId).map((event) => ({
        type: event.type,
        runId: event.runId,
        reason: event.reason
      })),
      [{ type: 'run_interrupted', runId, reason: 'app_restarted' }]
    )

    recoverInterruptedPhiSessions()
    assert.equal(readSessionEvents(session.sessionId).length, 1)
  })
})
