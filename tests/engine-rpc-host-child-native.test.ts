import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import {
  createRpcChildHostStartRequest,
  parseRpcChildHostCancelReceipt,
  parseRpcChildHostStartReceipt,
  RPC_CHILD_HOST_CANCEL_COMMAND,
  RPC_CHILD_HOST_START_COMMAND
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-host-start'
import { taskAdmissionCli, taskProbeFrames } from './helpers/rpcTaskAdmissionCli'

test('real idle SDK command starts the compiled background child without a Main model turn', async (t) => {
  const f = await taskAdmissionCli({ hostStart: true })
  t.after(f.close)
  const state = await f.connection.request<{ sessionId: string; sessionFile: string }>({
    type: 'get_state'
  })
  const config = f.childConfig!
  const root = {
    phiSessionId: config.phiSessionId,
    projectId: config.projectId,
    cwd: config.projectRoot,
    generation: config.generation,
    rootAgentId: 'Main',
    rootOmpSessionId: state.sessionId,
    rootSessionFile: state.sessionFile
  }
  const request = createRpcChildHostStartRequest(
    config,
    root,
    randomUUID(),
    f.backgroundNativeName!,
    'Return a plain final response'
  )
  const result = await f.connection.prompt(
    `/${RPC_CHILD_HOST_START_COMMAND} ${JSON.stringify(request)}`
  )
  assert.equal(result.agentInvoked, false)
  const receipt = taskProbeFrames(f, 'phi_rpc_child_host_start_receipt')[0]
  assert.ok(receipt, JSON.stringify(f.frames.filter((frame) => frame.type === 'extension_error')))
  const verified = parseRpcChildHostStartReceipt(JSON.stringify(receipt), request, config)
  assert.equal(verified.agent, f.backgroundNativeName)
  assert.equal(verified.parentToolCallId, request.id)
  for (let i = 0; i < 300 && !f.requests.some((item) => item.actor === 'child'); i++)
    await delay(10)
  assert.equal(
    f.requests.some((item) => item.actor === 'root'),
    false
  )
  assert.equal(
    f.requests.some((item) => item.actor === 'child'),
    true
  )
  const cancelled = await f.connection.prompt(
    `/${RPC_CHILD_HOST_CANCEL_COMMAND} ${JSON.stringify(request)}`
  )
  assert.equal(cancelled.agentInvoked, false)
  const cancelReceipt = taskProbeFrames(f, 'phi_rpc_child_host_cancel_receipt')[0]
  assert.ok(cancelReceipt)
  assert.equal(
    parseRpcChildHostCancelReceipt(JSON.stringify(cancelReceipt), request, config).state,
    'quiescent'
  )
})

test('remote cancellation tombstones a request before any native dispatch', async (t) => {
  const f = await taskAdmissionCli({ hostStart: true })
  t.after(f.close)
  const state = await f.connection.request<{ sessionId: string; sessionFile: string }>({
    type: 'get_state'
  })
  const config = f.childConfig!
  const request = createRpcChildHostStartRequest(
    config,
    {
      phiSessionId: config.phiSessionId,
      projectId: config.projectId,
      cwd: config.projectRoot,
      generation: config.generation,
      rootAgentId: 'Main',
      rootOmpSessionId: state.sessionId,
      rootSessionFile: state.sessionFile
    },
    randomUUID(),
    f.backgroundNativeName!,
    'Do not launch this task'
  )
  await f.connection.prompt(`/${RPC_CHILD_HOST_CANCEL_COMMAND} ${JSON.stringify(request)}`)
  const cancelReceipt = taskProbeFrames(f, 'phi_rpc_child_host_cancel_receipt')[0]
  assert.ok(cancelReceipt)
  assert.equal(
    parseRpcChildHostCancelReceipt(JSON.stringify(cancelReceipt), request, config).state,
    'quiescent'
  )
  await f.connection.prompt(`/${RPC_CHILD_HOST_START_COMMAND} ${JSON.stringify(request)}`)
  assert.equal(taskProbeFrames(f, 'phi_rpc_child_host_start_receipt').length, 0)
  assert.equal(
    f.requests.some((item) => item.actor === 'child'),
    false
  )
})

test('concurrent cancel tombstones a delayed start before native dispatch', async (t) => {
  const f = await taskAdmissionCli({ hostStart: true, hostStartDelayMs: 250 })
  t.after(f.close)
  const state = await f.connection.request<{ sessionId: string; sessionFile: string }>({
    type: 'get_state'
  })
  const config = f.childConfig!
  const request = createRpcChildHostStartRequest(
    config,
    {
      phiSessionId: config.phiSessionId,
      projectId: config.projectId,
      cwd: config.projectRoot,
      generation: config.generation,
      rootAgentId: 'Main',
      rootOmpSessionId: state.sessionId,
      rootSessionFile: state.sessionFile
    },
    randomUUID(),
    f.backgroundNativeName!,
    'Return a plain final response'
  )
  const start = f.connection.prompt(`/${RPC_CHILD_HOST_START_COMMAND} ${JSON.stringify(request)}`)
  const cancel = f.connection.prompt(`/${RPC_CHILD_HOST_CANCEL_COMMAND} ${JSON.stringify(request)}`)
  await Promise.all([start, cancel])
  const started = taskProbeFrames(f, 'phi_rpc_child_host_start_receipt')
  const stopped = taskProbeFrames(f, 'phi_rpc_child_host_cancel_receipt')
  assert.equal(started.length, 0)
  assert.equal(stopped.length, 1)
  assert.equal(
    parseRpcChildHostCancelReceipt(JSON.stringify(stopped[0]), request, config).state,
    'quiescent'
  )
  assert.equal(
    f.requests.some((item) => item.actor === 'child'),
    false
  )
})
