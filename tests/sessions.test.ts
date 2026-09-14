import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  acknowledgeSession,
  mergePhiSessionState,
  phiOnlySessionPath
} from '../src/main/agent/session/sessions'
import type { SessionInfo } from '../src/main/agent/runtime/runtime-adapter'
import {
  appendSessionEvent,
  createPhiSession,
  listPhiSessions,
  updateSessionManifest,
  type PhiSessionManifest
} from '../src/main/agent/session/session-store'

function withPhiDir<T>(callback: () => T): T {
  const previous = process.env.PI_CODING_AGENT_DIR
  const phiDir = mkdtempSync(join(tmpdir(), 'phi-sessions-'))
  process.env.PI_CODING_AGENT_DIR = phiDir
  try {
    return callback()
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = previous
    }
    rmSync(phiDir, { recursive: true, force: true })
  }
}

function sessionInfo(
  path: string,
  modified: string,
  overrides: Partial<SessionInfo> = {}
): SessionInfo {
  return {
    path,
    id: path,
    created: new Date('2026-09-05T00:00:00.000Z'),
    modified: new Date(modified),
    messageCount: 1,
    firstMessage: path,
    ...overrides
  }
}

function manifest(
  sessionId: string,
  runtimeSessionPath: string | undefined,
  status: PhiSessionManifest['status'],
  unreadKind: PhiSessionManifest['unreadKind'],
  lastActivityAt: string,
  cwd = '/workspace',
  createdAt = '2026-09-05T00:00:00.000Z'
): PhiSessionManifest {
  return {
    schemaVersion: 1,
    sessionId,
    kind: 'ordinary',
    projectId: null,
    cwd,
    cwdRealPath: cwd,
    ...(runtimeSessionPath ? { runtimeSessionPath } : {}),
    permissionMode: 'auto',
    status,
    unreadKind,
    messageCount: 1,
    createdAt,
    updatedAt: lastActivityAt,
    lastActivityAt
  }
}

test('mergePhiSessionState overlays Phi status without auto-sorting by activity', () => {
  const sessions = mergePhiSessionState(
    [
      sessionInfo('/sessions/idle.jsonl', '2026-09-05T10:00:00.000Z'),
      sessionInfo('/sessions/approval.jsonl', '2026-09-05T09:00:00.000Z', {
        created: new Date('2026-09-05T00:00:01.000Z')
      }),
      sessionInfo('/sessions/running.jsonl', '2026-09-05T08:00:00.000Z', {
        created: new Date('2026-09-05T00:00:02.000Z')
      })
    ],
    [
      manifest(
        'phi-approval',
        '/sessions/approval.jsonl',
        'needs_approval',
        'approval',
        '2026-09-05T09:30:00.000Z',
        '/workspace',
        '2026-09-05T00:00:01.000Z'
      ),
      manifest(
        'phi-running',
        '/sessions/running.jsonl',
        'running',
        null,
        '2026-09-05T08:30:00.000Z',
        '/workspace',
        '2026-09-05T00:00:02.000Z'
      )
    ],
    '/workspace'
  )

  assert.deepEqual(
    sessions.map((session) => session.path),
    [phiOnlySessionPath('phi-running'), phiOnlySessionPath('phi-approval'), '/sessions/idle.jsonl']
  )
  assert.equal(sessions[1].phiSessionId, 'phi-approval')
  assert.equal(sessions[1].status, 'needs_approval')
  assert.equal(sessions[1].unreadKind, 'approval')
  assert.equal(sessions[1].modified, '2026-09-05T09:30:00.000Z')
  assert.equal(sessions[2].status, 'idle')
  assert.equal(sessions[2].unreadKind, null)
})

test('mergePhiSessionState keeps Phi created time stable when runtime metadata changes', () => {
  const sessions = mergePhiSessionState(
    [
      sessionInfo('/sessions/original-first.jsonl', '2026-09-05T11:00:00.000Z', {
        created: new Date('2026-09-05T00:05:00.000Z')
      }),
      sessionInfo('/sessions/original-second.jsonl', '2026-09-05T10:00:00.000Z', {
        created: new Date('2026-09-05T00:10:00.000Z')
      })
    ],
    [
      manifest(
        'phi-original-first',
        '/sessions/original-first.jsonl',
        'idle',
        null,
        '2026-09-05T11:00:00.000Z',
        '/workspace',
        '2026-09-05T00:10:00.000Z'
      ),
      manifest(
        'phi-original-second',
        '/sessions/original-second.jsonl',
        'idle',
        null,
        '2026-09-05T10:00:00.000Z',
        '/workspace',
        '2026-09-05T00:05:00.000Z'
      )
    ],
    '/workspace'
  )

  assert.deepEqual(
    sessions.map((session) => session.path),
    [phiOnlySessionPath('phi-original-first'), phiOnlySessionPath('phi-original-second')]
  )
  assert.equal(sessions[0].created, '2026-09-05T00:10:00.000Z')
})

test('mergePhiSessionState ignores manifests from another cwd', () => {
  const [session] = mergePhiSessionState(
    [sessionInfo('/sessions/a.jsonl', '2026-09-05T10:00:00.000Z')],
    [
      manifest(
        'phi-other',
        '/sessions/a.jsonl',
        'failed',
        'failed',
        '2026-09-05T11:00:00.000Z',
        '/other'
      )
    ],
    '/workspace'
  )

  assert.equal(session.status, 'idle')
  assert.equal(session.phiSessionId, undefined)
})

test('mergePhiSessionState hides empty unnamed idle sessions', () => {
  const sessions = mergePhiSessionState(
    [
      sessionInfo('/sessions/blank.jsonl', '2026-09-05T10:00:00.000Z', {
        messageCount: 0,
        firstMessage: ''
      }),
      sessionInfo('/sessions/named.jsonl', '2026-09-05T09:00:00.000Z', {
        name: '手动标题',
        messageCount: 0,
        firstMessage: ''
      }),
      sessionInfo('/sessions/message.jsonl', '2026-09-05T08:00:00.000Z')
    ],
    [],
    '/workspace'
  )

  assert.deepEqual(
    sessions.map((session) => session.path),
    ['/sessions/named.jsonl', '/sessions/message.jsonl']
  )
})

test('mergePhiSessionState keeps empty sessions with active Phi state visible', () => {
  const sessions = mergePhiSessionState(
    [
      sessionInfo('/sessions/running-empty.jsonl', '2026-09-05T10:00:00.000Z', {
        messageCount: 0,
        firstMessage: ''
      }),
      sessionInfo('/sessions/failed-empty.jsonl', '2026-09-05T09:00:00.000Z', {
        messageCount: 0,
        firstMessage: ''
      })
    ],
    [
      {
        ...manifest(
          'phi-running-empty',
          '/sessions/running-empty.jsonl',
          'running',
          null,
          '2026-09-05T10:05:00.000Z'
        ),
        messageCount: 0,
        currentRunId: 'run-1'
      },
      {
        ...manifest(
          'phi-failed-empty',
          '/sessions/failed-empty.jsonl',
          'failed',
          'failed',
          '2026-09-05T09:05:00.000Z'
        ),
        messageCount: 0
      }
    ],
    '/workspace'
  )

  assert.deepEqual(
    sessions.map((session) => session.path),
    [phiOnlySessionPath('phi-running-empty'), phiOnlySessionPath('phi-failed-empty')]
  )
})

test('mergePhiSessionState exposes Phi-only conversations without runtime files', () => {
  withPhiDir(() => {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: '/workspace',
      cwdRealPath: '/workspace',
      title: '余额不足前的问题',
      permissionMode: 'auto'
    })
    appendSessionEvent(session.sessionId, {
      type: 'user_message',
      runId: 'run-1',
      content: '为什么聊天记录消失'
    })
    updateSessionManifest(session.sessionId, {
      status: 'failed',
      unreadKind: 'failed',
      lastRunOutcome: 'failed'
    })

    const [summary] = mergePhiSessionState([], listPhiSessions(), '/workspace')

    assert.equal(summary.path, phiOnlySessionPath(session.sessionId))
    assert.equal(summary.phiSessionId, session.sessionId)
    assert.equal(summary.name, '余额不足前的问题')
    assert.equal(summary.firstMessage, '余额不足前的问题')
    assert.equal(summary.status, 'failed')
    assert.equal(summary.unreadKind, 'failed')
  })
})

test('mergePhiSessionState omits composer file reference metadata from titles', () => {
  withPhiDir(() => {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: '/workspace',
      cwdRealPath: '/workspace',
      runtimeSessionPath: '/sessions/referenced.jsonl',
      permissionMode: 'auto'
    })
    appendSessionEvent(session.sessionId, {
      type: 'user_message',
      runId: 'run-1',
      content: '引用文件：\n- `./data.json`\n- `./metadata.csv`\n分析这个数据'
    })

    const [summary] = mergePhiSessionState(
      [sessionInfo('/sessions/referenced.jsonl', '2026-09-05T10:00:00.000Z')],
      listPhiSessions(),
      '/workspace'
    )

    assert.equal(summary.name, undefined)
    assert.equal(summary.firstMessage, '分析这个数据')
  })
})

test('mergePhiSessionState sanitizes legacy manifest titles with file reference metadata', () => {
  withPhiDir(() => {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: '/workspace',
      cwdRealPath: '/workspace',
      title: '引用文件：`./data.json`\n分析这个数据',
      permissionMode: 'auto'
    })
    appendSessionEvent(session.sessionId, {
      type: 'user_message',
      runId: 'run-1',
      content: '备用正文'
    })

    const [summary] = mergePhiSessionState([], listPhiSessions(), '/workspace')

    assert.equal(summary.name, '分析这个数据')
    assert.equal(summary.firstMessage, '分析这个数据')
  })
})

test('acknowledgeSession handles Phi-only conversations', () => {
  withPhiDir(() => {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: '/workspace',
      cwdRealPath: '/workspace',
      permissionMode: 'auto'
    })
    appendSessionEvent(session.sessionId, {
      type: 'user_message',
      runId: 'run-1',
      content: '需要恢复的问题'
    })
    updateSessionManifest(session.sessionId, {
      status: 'failed',
      unreadKind: 'failed',
      lastRunOutcome: 'failed'
    })

    const acknowledged = acknowledgeSession(phiOnlySessionPath(session.sessionId), '/workspace')

    assert.equal(acknowledged?.path, phiOnlySessionPath(session.sessionId))
    assert.equal(acknowledged?.firstMessage, '需要恢复的问题')
    assert.equal(acknowledged?.status, 'failed')
    assert.equal(acknowledged?.unreadKind, null)
  })
})

test('acknowledgeSession clears completed and failed unread state', () => {
  withPhiDir(() => {
    const completed = createPhiSession({
      kind: 'ordinary',
      cwd: '/workspace',
      cwdRealPath: '/workspace',
      runtimeSessionPath: '/sessions/done.jsonl',
      permissionMode: 'auto'
    })
    updateSessionManifest(completed.sessionId, {
      status: 'completed_unread',
      unreadKind: 'completed',
      lastRunOutcome: 'completed'
    })

    const acknowledged = acknowledgeSession('/sessions/done.jsonl', '/workspace')

    assert.equal(acknowledged?.status, 'idle')
    assert.equal(acknowledged?.unreadKind, null)
    assert.equal(listPhiSessions()[0].unreadKind, null)
  })
})

test('acknowledgeSession preserves failed status so opening does not reorder it as idle', () => {
  withPhiDir(() => {
    const failed = createPhiSession({
      kind: 'ordinary',
      cwd: '/workspace',
      cwdRealPath: '/workspace',
      runtimeSessionPath: '/sessions/failed.jsonl',
      permissionMode: 'auto'
    })
    updateSessionManifest(failed.sessionId, {
      status: 'failed',
      unreadKind: 'failed',
      lastRunOutcome: 'failed'
    })

    const acknowledged = acknowledgeSession('/sessions/failed.jsonl', '/workspace')

    assert.equal(acknowledged?.status, 'failed')
    assert.equal(acknowledged?.unreadKind, null)
    const [manifest] = listPhiSessions()
    assert.equal(manifest.status, 'failed')
    assert.equal(manifest.unreadKind, null)
  })
})

test('mergePhiSessionState exposes current run start time for elapsed labels', () => {
  const [session] = mergePhiSessionState(
    [sessionInfo('/sessions/running.jsonl', '2026-09-05T10:00:00.000Z')],
    [
      {
        ...manifest(
          'phi-running',
          '/sessions/running.jsonl',
          'running',
          null,
          '2026-09-05T10:05:00.000Z'
        ),
        currentRunId: 'run-1',
        currentRunStartedAt: '2026-09-05T10:00:30.000Z'
      }
    ],
    '/workspace'
  )

  assert.equal(session.currentRunStartedAt, '2026-09-05T10:00:30.000Z')
})

test('acknowledgeSession keeps active approval attention visible', () => {
  withPhiDir(() => {
    const approval = createPhiSession({
      kind: 'project',
      cwd: '/project',
      cwdRealPath: '/project',
      runtimeSessionPath: '/sessions/approval.jsonl',
      permissionMode: 'ask'
    })
    updateSessionManifest(approval.sessionId, {
      status: 'needs_approval',
      unreadKind: 'approval',
      currentRunId: 'run-1'
    })

    assert.equal(acknowledgeSession('/sessions/approval.jsonl', '/project'), null)

    const [manifest] = listPhiSessions()
    assert.equal(manifest.status, 'needs_approval')
    assert.equal(manifest.unreadKind, 'approval')
  })
})
