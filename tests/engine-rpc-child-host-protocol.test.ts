import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { rpcChildWrapperSourceMatches } from '../src/main/agent/engine/phi-extension/extensions/rpc-child-host-tools'
import {
  createRpcChildCall,
  parseRpcChildReply,
  parseRpcChildRequest
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import { hostResultPlaceholder } from '../src/main/agent/engine/phi-extension/lib/rpc-host-result-protocol'
import { childScope } from './helpers/rpcChildAuthorityFixture'

test('SDK MCP naming provenance never grants a native or non-MCP host wrapper', () => {
  assert.equal(
    rpcChildWrapperSourceMatches({ name: 'mcp__fixture_inspect', site: 'host' }, 'mcp'),
    true
  )
  assert.equal(
    rpcChildWrapperSourceMatches({ name: 'mcp__fixture_inspect', site: 'host' }, 'extension'),
    true
  )
  for (const tool of [
    { name: 'mcp__fixture_inspect', site: 'native' },
    { name: 'bash', site: 'native' },
    { name: 'skill_run', site: 'host' }
  ])
    assert.equal(rpcChildWrapperSourceMatches(tool, 'mcp'), false)
  assert.equal(
    rpcChildWrapperSourceMatches({ name: 'mcp__fixture_inspect', site: 'host' }, 'sdk'),
    false
  )
})
test('child host execute and consumed protocol bind the exact invocation and admit only signed delivery placeholders', () => {
  const call = createRpcChildCall(childScope, 'host-call', 'skill_run', {
    skill: 'trusted',
    script: 'tiny.sh'
  })
  const request = {
    schema: 1 as const,
    id: randomUUID(),
    operation: 'execute' as const,
    capability: 'a'.repeat(64),
    sequence: 4,
    scope: childScope,
    call
  }
  const reply = {
    schema: 1,
    id: request.id,
    operation: 'execute',
    sequence: 4,
    allowed: true,
    result: {
      runId: 'private-child-run',
      invocationId: request.id,
      payload: hostResultPlaceholder(true)
    }
  }
  assert.equal(parseRpcChildReply(JSON.stringify(reply), request).result?.invocationId, request.id)
  for (const patch of [
    { content: [{ type: 'text', text: 'untrusted inline data' }], isError: true },
    { ...hostResultPlaceholder(), isError: false },
    { ...hostResultPlaceholder(), details: { untrusted: true } }
  ])
    assert.throws(() =>
      parseRpcChildReply(
        JSON.stringify({ ...reply, result: { ...reply.result, payload: patch } }),
        request
      )
    )
  assert.throws(() =>
    parseRpcChildReply(
      JSON.stringify({ ...reply, result: { ...reply.result, invocationId: randomUUID() } }),
      request
    )
  )
  const consumed = {
    ...request,
    id: randomUUID(),
    operation: 'result_consumed',
    sequence: 5,
    invocationId: request.id
  }
  assert.equal(parseRpcChildRequest(JSON.stringify(consumed)).operation, 'result_consumed')
  assert.throws(() =>
    parseRpcChildRequest(JSON.stringify({ ...consumed, invocationId: consumed.id }))
  )
})
