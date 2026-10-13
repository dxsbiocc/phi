import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { setImmediate as turn } from 'node:timers/promises'
import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import { RpcExecutionAuthority } from '../src/main/agent/engine/rpc/execution-authority'
import { createApprovalEnvelope } from '../src/main/agent/engine/phi-extension/lib/rpc-approval-protocol'
import {
  executionBinding,
  executionRoster,
  parseExecutionMessage,
  RPC_EXECUTION_COMMAND,
  RPC_EXECUTION_DESCRIPTION,
  signExecutionMessage,
  type RpcExecutionControl,
  type RpcExecutionMessage
} from '../src/main/agent/engine/phi-extension/lib/rpc-execution-protocol'
import { createInitializationWire } from './helpers/rpc-initialization-wire'
import { executionUntil } from './helpers/rpcExecutionAuthorityFixture'

const capability = 'b'.repeat(64)
const identity = {
  nonce: '0123456789abcdef',
  phiSessionId: 'phi',
  projectId: 'project',
  cwd: '/project',
  generation: 1
}
const roster = [{ name: 'write', site: 'native' as const }]
async function lifecycleFixture(holdEnd = false): Promise<{
  authority: RpcExecutionAuthority
  controls: RpcExecutionControl[]
  wire: ReturnType<typeof createInitializationWire>
  completePrompt(): void
  releaseAbort(): void
  releaseEnd(): void
  abortPending(): boolean
  endPending(): boolean
  mainPending(): boolean
}> {
  let mainId: string | undefined
  let abort: (() => void) | undefined
  let end: (() => void) | undefined
  const controls: RpcExecutionControl[] = []
  const wire = createInitializationWire((command, respond, emit) => {
    if (command.type === 'get_state') {
      respond({ sessionId: 'omp' })
      return true
    }
    if (command.type === 'get_available_commands') {
      respond({
        commands: [
          {
            name: RPC_EXECUTION_COMMAND,
            description: RPC_EXECUTION_DESCRIPTION,
            source: 'extension'
          }
        ]
      })
      return true
    }
    if (command.type === 'abort') {
      abort = () => respond({})
      return true
    }
    if (command.type !== 'prompt') return false
    if (!String(command.message).startsWith(`/${RPC_EXECUTION_COMMAND} `)) {
      mainId = command.id
      respond({ agentInvoked: true })
      return true
    }
    const request = parseExecutionMessage(
      String(command.message).slice(RPC_EXECUTION_COMMAND.length + 2),
      capability
    )
    if (!request || request.type !== 'phi_rpc_execution_control')
      throw new Error('Expected signed control')
    controls.push(request)
    const finish = (): void => {
      emit({
        type: 'extension_ui_request',
        id: request.requestId,
        method: 'notify',
        message: JSON.stringify(
          signExecutionMessage(
            {
              ...executionBinding(request),
              type: 'phi_rpc_execution_ack',
              action: request.action,
              requestId: request.requestId
            },
            capability
          )
        )
      })
      respond({ agentInvoked: false })
      emit({
        type: 'prompt_result',
        id: command.id,
        agentInvoked: false,
        status: 'completed',
        sessionSettled: true
      })
    }
    if (holdEnd && request.action === 'end') end = finish
    else finish()
    return true
  })
  const connection = new RpcConnection(() => wire.transport)
  await connection.start()
  const authority = await RpcExecutionAuthority.create({ connection, identity, capability, roster })
  return {
    authority,
    wire,
    controls,
    completePrompt: () => {
      if (!mainId) throw new Error('No main prompt')
      wire.emit({
        type: 'prompt_result',
        id: mainId,
        agentInvoked: true,
        status: 'aborted',
        sessionSettled: true
      })
    },
    releaseAbort: () => abort?.(),
    releaseEnd: () => end?.(),
    abortPending: () => !!abort,
    endPending: () => !!end,
    mainPending: () => !!mainId
  }
}

test('held abort ACK after prompt result shares one pending retirement and preserves the next run', async (t) => {
  const f = await lifecycleFixture(true)
  t.after(() => f.authority.dispose())
  await f.authority.beginRun('stopped-run')
  const prompt = f.authority.prompt('synthetic prompt').catch((error) => error)
  await executionUntil(() => f.mainPending())
  let stopError: unknown
  const stop = f.authority.cancelRun().catch((error) => {
    stopError = error
  })
  await executionUntil(() => f.abortPending())
  f.completePrompt()
  await executionUntil(() => f.endPending())
  f.releaseAbort()
  await turn()
  await turn()
  const errorBeforeEnd = stopError
  f.releaseEnd()
  await Promise.all([prompt, stop])
  assert.equal(errorBeforeEnd, undefined)
  assert.equal(stopError, undefined)
  assert.equal(
    f.controls.filter((control) => control.action === 'end' && control.runId === 'stopped-run')
      .length,
    1
  )
  const next = await f.authority.beginRun('next-run')
  assert.equal(next.signal.aborted, false)
  const finishing = f.authority.finishRun(next.id)
  await executionUntil(() =>
    f.controls.some((control) => control.action === 'end' && control.runId === next.id)
  )
  f.releaseEnd()
  await finishing
})

test('late abort ACK after completed retirement cannot repeat end or retire an already-bound successor', async (t) => {
  const f = await lifecycleFixture()
  t.after(() => f.authority.dispose())
  await f.authority.beginRun('stopped-run')
  const prompt = f.authority.prompt('synthetic prompt').catch((error) => error)
  await executionUntil(() => f.mainPending())
  let stopError: unknown
  const stop = f.authority.cancelRun().catch((error) => {
    stopError = error
  })
  await executionUntil(() => f.abortPending())
  f.completePrompt()
  await prompt
  const next = await f.authority.beginRun('next-run')
  f.releaseAbort()
  await stop
  assert.equal(stopError, undefined)
  assert.equal(
    f.controls.filter((control) => control.action === 'end' && control.runId === 'stopped-run')
      .length,
    1
  )
  assert.equal(f.authority.currentRun(), next)
  assert.equal(next.signal.aborted, false)
  await f.authority.finishRun(next.id)
})

for (const phase of ['activated-idle', 'completed-idle'] as const)
  test(`signed main generation retirement closes ${phase} without waiting for a future begin failure`, async (t) => {
    const f = await lifecycleFixture()
    t.after(() => f.authority.dispose())
    if (phase === 'completed-idle') {
      const run = await f.authority.beginRun('finished')
      await f.authority.finishRun(run.id)
    }
    const latest = f.controls.at(-1)!
    assert.equal(f.authority.currentRun(), undefined)
    f.wire.emit({
      type: 'extension_ui_request',
      id: 'idle-retirement',
      method: 'notify',
      message: JSON.stringify(
        signExecutionMessage(
          {
            ...executionBinding(latest),
            type: 'phi_rpc_execution_retired',
            reason: 'session-change'
          },
          capability
        )
      )
    })
    await turn()
    await turn()
    assert.throws(() => f.authority.sessionIdentity(), /unavailable/u)
    await f.authority.dispose()
    assert.equal(f.wire.closeCalls(), 1)
  })

// Independently sign malformed untrusted wire JSON, bypassing the typed signer.
function malformedSigned(body: Record<string, unknown>): string {
  const canonical = {
    nonce: '0123456789abcdef',
    phiSessionId: 'execution',
    ompSessionId: 'execution',
    projectId: 'execution',
    cwd: '/',
    generation: 1,
    runId: 'execution'
  }
  const digest = createApprovalEnvelope(canonical, 'execution', 'execution', body).inputDigest
  const proof = createHmac('sha256', Buffer.from(capability, 'hex')).update(digest).digest('hex')
  return JSON.stringify({ ...body, proof })
}
for (const field of ['rosterHash', 'inputDigest'] as const)
  test(`strict parser rejects valid-HMAC array typed ${field}`, () => {
    const message: RpcExecutionMessage = {
      ...identity,
      ompSessionId: 'omp',
      runId: 'run',
      protocolVersion: 1,
      type: 'phi_rpc_execution_origin',
      rosterHash: executionRoster(roster).hash,
      sequence: 2,
      originSequence: 1,
      toolCallId: 'call',
      toolName: 'write',
      inputDigest: 'a'.repeat(64)
    }
    assert.equal(
      parseExecutionMessage(malformedSigned({ ...message, [field]: [message[field]] }), capability),
      undefined
    )
  })
