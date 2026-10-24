import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createProductionChildConfig } from '../src/main/agent/engine/rpc/subagents/production-child-config'
import { productionChildOptions } from './helpers/productionChildNodeFixture'
import {
  createRpcChildHostStartRequest,
  makeRpcChildHostCancelReceipt,
  makeRpcChildHostStartReceipt,
  parseRpcChildHostCancelReceipt,
  parseRpcChildHostStartReceipt,
  parseRpcChildHostStartRequest
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-host-start'

test('host child start binds an idle request and result to one root, agent and generation', async () => {
  const { config } = await createProductionChildConfig(
    productionChildOptions({ allowBackground: true })
  )
  const root = {
    phiSessionId: config.phiSessionId,
    projectId: config.projectId,
    cwd: config.projectRoot,
    generation: config.generation,
    rootAgentId: 'Main',
    rootOmpSessionId: 'root-sdk',
    rootSessionFile: '/srv/history/root.jsonl'
  }
  const agent = config.profiles.find((profile) => !profile.definition.blocking)!.definition
    .nativeName
  const request = createRpcChildHostStartRequest(
    config,
    root,
    randomUUID(),
    agent,
    'Complete plan step'
  )
  assert.deepEqual(parseRpcChildHostStartRequest(JSON.stringify(request), config, root), request)
  const receipt = makeRpcChildHostStartReceipt(request, config, {
    nativeId: 'native-child',
    parentToolCallId: request.id,
    childSessionFile: '/srv/history/root/child.jsonl'
  })
  assert.deepEqual(parseRpcChildHostStartReceipt(JSON.stringify(receipt), request, config), receipt)
  assert.throws(
    () =>
      parseRpcChildHostStartRequest(JSON.stringify(request), config, {
        ...root,
        rootOmpSessionId: 'other'
      }),
    /binding changed/
  )
  assert.throws(
    () =>
      parseRpcChildHostStartRequest(JSON.stringify({ ...request, task: 'injected' }), config, root),
    /authentication failed/
  )
  assert.throws(
    () =>
      parseRpcChildHostStartReceipt(
        JSON.stringify({ ...receipt, nativeId: 'other' }),
        request,
        config
      ),
    /authentication failed/
  )
  assert.throws(
    () =>
      parseRpcChildHostStartReceipt(JSON.stringify({ ...receipt, id: 'other' }), request, config),
    /binding changed/
  )
  const wrongOwner = makeRpcChildHostStartReceipt(request, config, {
    nativeId: 'native-child',
    parentToolCallId: 'different-task',
    childSessionFile: '/srv/history/root/child.jsonl'
  })
  assert.throws(
    () => parseRpcChildHostStartReceipt(JSON.stringify(wrongOwner), request, config),
    /Invalid Phi child host receipt/
  )
  const cancelled = makeRpcChildHostCancelReceipt(request, config, 'quiescent', ['native-child'])
  assert.equal(
    parseRpcChildHostCancelReceipt(JSON.stringify(cancelled), request, config).state,
    'quiescent'
  )
  assert.throws(
    () =>
      parseRpcChildHostCancelReceipt(
        JSON.stringify({ ...cancelled, state: 'unknown' }),
        request,
        config
      ),
    /authentication failed/
  )
  assert.throws(
    () =>
      makeRpcChildHostStartReceipt(request, config, {
        nativeId: 'native-child',
        parentToolCallId: request.id,
        childSessionFile: '/srv/history/other/child.jsonl'
      }),
    /Invalid Phi child host start result/
  )
})
