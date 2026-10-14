import type { SessionRun } from '../../src/main/agent/session/session-runner-registry'
import type { RpcVerifiedTaskOrigin } from '../../src/main/agent/engine/rpc/execution-authority'
import type { CreateProductionChildConfigOptions } from '../../src/main/agent/engine/rpc/subagents/production-child-config'
import type { RpcChildStarted } from '../../src/main/agent/engine/rpc/subagents/run-registry'
import { definition } from './rpcAgentDefinitionFixture'

export function productionChildOptions(
  overrides: Partial<CreateProductionChildConfigOptions> = {}
): CreateProductionChildConfigOptions {
  return {
    identity: {
      nonce: '12345678-1234-4234-8234-123456789012',
      phiSessionId: 'phi-session',
      projectId: 'project',
      projectRoot: '/srv/project',
      generation: 1
    },
    binding: {
      serverId: 'host-profile',
      serverIdentitySha256: 'a'.repeat(64),
      projectId: 'project',
      projectRoot: '/srv/project'
    },
    definitions: [
      definition({
        name: 'Writer',
        skills: [],
        tools: ['read', 'write', 'bash'],
        systemPrompt: 'PRIVATE_CHILD_SYSTEM'
      })
    ],
    modelDescriptors: [
      {
        provider: 'fixture',
        id: 'model',
        name: 'Model',
        reasoning: false,
        input: ['text'],
        contextWindow: 32768,
        maxTokens: 1024
      }
    ],
    parentModel: { provider: 'fixture', id: 'model' },
    parentThinkingLevel: 'off',
    native: {
      endpoint: 'http://127.0.0.1:34567/v1/pi/stream',
      models: [{ provider: 'fixture', id: 'model' }]
    },
    otherCapabilities: ['b'.repeat(64), 'c'.repeat(64)],
    ...overrides
  }
}

/** Unit-only run data; product acceptance separately obtains SessionRun from the real registry. */
export function ledgerRun(
  sessionId = 'phi-session',
  runId = 'parent-run'
): { run: SessionRun; controller: AbortController } {
  const controller = new AbortController()
  return {
    controller,
    run: {
      sessionId,
      runId,
      signal: controller.signal,
      startedAt: new Date().toISOString(),
      done: Promise.resolve(),
      status: 'running'
    }
  }
}
/** Unit input for the already-verified callback, not an imitation of HMAC authentication. */
export function ledgerOrigin(parent: SessionRun, toolCallId = 'outer-task'): RpcVerifiedTaskOrigin {
  return {
    run: { id: parent.runId, signal: parent.signal, authorizeCall: () => undefined },
    origin: {
      type: 'phi_rpc_execution_origin',
      protocolVersion: 1,
      nonce: '12345678-1234-4234-8234-123456789012',
      phiSessionId: parent.sessionId,
      projectId: 'project',
      cwd: '/srv/project',
      generation: 1,
      ompSessionId: 'root-sdk',
      runId: parent.runId,
      rosterHash: 'd'.repeat(64),
      sequence: 2,
      originSequence: 1,
      toolCallId,
      toolName: 'task',
      inputDigest: 'e'.repeat(64)
    }
  }
}
export function ledgerStarted(
  id = 'native-child',
  parentToolCallId = 'outer-task'
): RpcChildStarted {
  return {
    id,
    parentToolCallId,
    agent: 'phi_native_fg',
    agentSource: 'user',
    sessionFile: '/srv/history/root/child.jsonl',
    detached: false
  }
}
