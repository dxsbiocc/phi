import assert from 'node:assert/strict'
import test from 'node:test'

import type { JsonValue } from '../src/shared/kernel-protocol'
import { KernelProtocolCore } from '../src/kernel/protocol'
import { bindWorkerOutbound } from '../src/kernel/worker/outbound'
import { requestHost, sendEvent } from '../src/main/agent/engine/in-process/ipc'

function bindWithActiveRun(activeRun: string | undefined): {
  contexts: unknown[]
  unbind: () => void
} {
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
    await requestHost(
      'skills.scriptTool',
      { tool: 'viz_catalog' },
      {
        originSessionId: 'session-1',
        agentRunId: 'child-run'
      }
    )
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
    await requestHost(
      'skills.scriptTool',
      { tool: 'viz_catalog' },
      {
        originSessionId: 'session-1',
        agentRunId: 'child-run'
      }
    )
    assert.deepEqual(contexts, [
      { sessionId: 'session-1', runId: 'child-run', agentRunId: 'child-run' }
    ])
  } finally {
    unbind()
  }
})

function bindCore(core: KernelProtocolCore, activeRun: string | undefined): () => void {
  return bindWorkerOutbound({
    agentDir: '/trusted/agent',
    core,
    activeRunId: () => activeRun,
    persistentSession: () => undefined,
    projectSessionState: () => null,
    diagnoseDroppedEvent: () => undefined,
    rejectAuthPrompt: () => undefined
  })
}

test('a child approval is owned by the child run and survives parent completion', () => {
  const decisions: JsonValue[] = []
  const core = new KernelProtocolCore({
    kernelVersion: 'child-approval-test',
    ompVersion: 'child-approval-test',
    kernelInstanceId: 'child-approval-test',
    handlers: {
      'approval.respond': (params: JsonValue) => {
        decisions.push(params)
        return { accepted: true }
      }
    }
  })
  const unbind = bindCore(core, 'parent-run')
  try {
    sendEvent(
      'toolApproval',
      {
        requestId: 'child-approval',
        toolCallId: 'child-tool',
        toolName: 'bash',
        input: { command: '/bin/bash child.sh' },
        agentRunId: 'child-run'
      },
      { sessionId: 'session-1' }
    )

    core.emitEvent(
      'run.completed',
      { runId: 'parent-run', status: 'completed' },
      { sessionId: 'session-1', runId: 'parent-run' }
    )
    assert.deepEqual(decisions, [], 'parent completion must not deny an independent child approval')

    core.cancelAgentRunInteractions('session-1', 'child-run', 'agent run ended')
    assert.deepEqual(decisions, [
      { approvalId: 'child-approval', decision: 'denied', reason: 'agent run ended' }
    ])
  } finally {
    unbind()
  }
})

test('a parent-owned approval is still cancelled by parent completion', () => {
  const decisions: JsonValue[] = []
  const core = new KernelProtocolCore({
    kernelVersion: 'parent-approval-test',
    ompVersion: 'parent-approval-test',
    kernelInstanceId: 'parent-approval-test',
    handlers: {
      'approval.respond': (params: JsonValue) => {
        decisions.push(params)
        return { accepted: true }
      }
    }
  })
  const unbind = bindCore(core, 'parent-run')
  try {
    sendEvent(
      'toolApproval',
      {
        requestId: 'parent-approval',
        toolCallId: 'parent-tool',
        toolName: 'bash',
        input: { command: '/bin/bash parent.sh' }
      },
      { sessionId: 'session-1' }
    )

    core.emitEvent(
      'run.completed',
      { runId: 'parent-run', status: 'completed' },
      { sessionId: 'session-1', runId: 'parent-run' }
    )
    assert.deepEqual(decisions, [
      { approvalId: 'parent-approval', decision: 'denied', reason: 'run ended' }
    ])
  } finally {
    unbind()
  }
})
