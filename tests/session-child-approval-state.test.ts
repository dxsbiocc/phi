import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionRunnerRegistry,
  type SessionRun
} from '../src/main/agent/session/session-runner-registry'
import {
  createPhiSession,
  createRunId,
  findPhiSessionById,
  readSessionEvents
} from '../src/main/agent/session/session-store'

import { createFacadeChildApprovalWriter } from '../src/main/agent/engine/rpc/facade-child-approval'
import type { RpcApprovalEvent } from '../src/main/agent/engine/rpc/approval-bridge'

interface StateFixture {
  phi: ReturnType<typeof createPhiSession>
  registry: SessionRunnerRegistry
  run(): SessionRun
  release(): void
  close(): Promise<void>
}
async function fixture(): Promise<StateFixture> {
  const old = process.env.PI_CODING_AGENT_DIR
  const root = await mkdtemp(join(tmpdir(), 'phi-child-approval-state-'))
  process.env.PI_CODING_AGENT_DIR = root
  const phi = createPhiSession({
    kind: 'ordinary',
    cwd: '/private-fixture',
    cwdRealPath: '/private-fixture',
    permissionMode: 'ask'
  })
  const registry = new SessionRunnerRegistry()
  let release!: () => void
  const run = (): SessionRun =>
    registry.startRun({
      sessionId: phi.sessionId,
      runId: createRunId(),
      execute: () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    })
  return {
    phi,
    registry,
    run,
    release: () => release(),
    async close() {
      if (old === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = old
      await rm(root, { recursive: true, force: true })
    }
  }
}

test('child approval state waits for every pending ID and preserves denial without duplicate durable events', async () => {
  const f = await fixture()
  const parent = f.run()
  await Promise.resolve()
  try {
    f.registry.setChildApprovalState(parent, 'a', 'approval_requested')
    f.registry.setChildApprovalState(parent, 'b', 'approval_requested')
    f.registry.setChildApprovalState(parent, 'a', 'approval_approved')
    assert.equal(parent.status, 'needs_approval')
    assert.equal(findPhiSessionById(f.phi.sessionId)!.status, 'needs_approval')
    f.registry.setChildApprovalState(parent, 'b', 'approval_denied')
    assert.equal(findPhiSessionById(f.phi.sessionId)!.status, 'failed')
    f.registry.setChildApprovalState(parent, 'c', 'approval_requested')
    f.registry.setChildApprovalState(parent, 'c', 'approval_approved')
    f.registry.setChildApprovalState(parent, 'a', 'approval_requested')
    assert.equal(parent.status, 'running')
    assert.equal(findPhiSessionById(f.phi.sessionId)!.status, 'failed')
    assert.equal(
      readSessionEvents(f.phi.sessionId).some((event) => event.type.startsWith('approval_')),
      false
    )
  } finally {
    f.release()
    await parent.done
    await f.close()
  }
})

test('a stopped or replaced exact parent cannot change the next real run approval state', async () => {
  const f = await fixture()
  const first = f.run()
  await Promise.resolve()
  try {
    f.registry.setChildApprovalState(first, 'old', 'approval_requested')
    f.registry.stopRun(f.phi.sessionId)
    f.registry.setChildApprovalState(first, 'old', 'approval_approved')
    assert.equal(first.status, 'needs_approval')
    f.release()
    await first.done
    const second = f.run()
    await Promise.resolve()
    try {
      f.registry.setChildApprovalState(second, 'new', 'approval_requested')
      f.registry.setChildApprovalState(first, 'old', 'approval_denied')
      assert.equal(second.status, 'needs_approval')
      assert.equal(second.signal.aborted, false)
      assert.equal(findPhiSessionById(f.phi.sessionId)!.status, 'needs_approval')
      f.registry.setChildApprovalState(second, 'new', 'approval_approved')
      assert.equal(second.status, 'running')
    } finally {
      f.release()
      await second.done
    }
  } finally {
    f.release()
    await first.done
    await f.close()
  }
})

function approval(parent: SessionRun, type: RpcApprovalEvent['type']): RpcApprovalEvent {
  return {
    type,
    sessionId: parent.sessionId,
    runId: 'child-uuid',
    approvalId: 'approval-id',
    toolCallId: 'tool-call',
    request: {
      requestId: 'approval-id',
      sessionId: parent.sessionId,
      runId: 'child-uuid',
      agentRunId: 'child-uuid',
      toolCallId: 'tool-call',
      toolName: 'write',
      summary: 'write private-fixture/output.txt',
      cwd: '/private-fixture'
    }
  }
}
test('single child writer persists one request/terminal and ignores observer failures without duplicate main events', async () => {
  const f = await fixture(),
    parent = f.run()
  await Promise.resolve()
  let notices = 0
  try {
    const write = createFacadeChildApprovalWriter({
      phiSessionId: parent.sessionId,
      cwd: '/private-fixture',
      runners: f.registry,
      notify() {
        notices++
        throw new Error('notification only')
      }
    })
    write(parent, approval(parent, 'approval_requested'))
    write(parent, approval(parent, 'approval_requested'))
    write(parent, approval(parent, 'approval_approved'))
    write(parent, approval(parent, 'approval_approved'))
    const events = readSessionEvents(parent.sessionId).filter((event) =>
      event.type.startsWith('approval_')
    )
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval_requested', 'approval_approved']
    )
    assert.ok(
      events.every(
        (event) =>
          event.runId === 'child-uuid' &&
          event.agentRunId === 'child-uuid' &&
          event.parentRunId === parent.runId &&
          event.toolCallId === 'tool-call'
      )
    )
    assert.equal(notices, 2)
    assert.equal(parent.status, 'running')
  } finally {
    f.release()
    await parent.done
    await f.close()
  }
})
test('late child terminal is recorded for its original parent while the successor stays approval-blocked', async () => {
  const f = await fixture(),
    first = f.run()
  await Promise.resolve()
  const write = createFacadeChildApprovalWriter({
    phiSessionId: first.sessionId,
    cwd: '/private-fixture',
    runners: f.registry
  })
  try {
    write(first, approval(first, 'approval_requested'))
    f.registry.stopRun(first.sessionId)
    f.release()
    await first.done
    const second = f.run()
    await Promise.resolve()
    try {
      f.registry.setChildApprovalState(second, 'second-pending', 'approval_requested')
      write(first, approval(first, 'approval_cancelled'))
      assert.equal(second.status, 'needs_approval')
      assert.equal(second.signal.aborted, false)
      assert.equal(findPhiSessionById(second.sessionId)!.status, 'needs_approval')
      const terminal = readSessionEvents(first.sessionId).filter(
        (event) => event.type === 'approval_cancelled'
      )
      assert.equal(terminal.length, 1)
      assert.equal(terminal[0].parentRunId, first.runId)
      assert.equal(terminal[0].runId, 'child-uuid')
    } finally {
      f.release()
      await second.done
    }
  } finally {
    f.release()
    await first.done
    await f.close()
  }
})
