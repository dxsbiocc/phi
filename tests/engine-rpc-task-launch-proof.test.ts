import assert from 'node:assert/strict'
import test from 'node:test'
import { createProductionChildConfig } from '../src/main/agent/engine/rpc/subagents/production-child-config'
import {
  makeRpcTaskLaunchReceipt,
  parseRpcTaskLaunchReceipt
} from '../src/main/agent/engine/phi-extension/lib/rpc-task-launch-protocol'
import { productionChildOptions } from './helpers/productionChildNodeFixture'
import { childScope } from './helpers/rpcChildAuthorityFixture'

test('parallel launch expectation seals exact admitted count only under the same private root and input proof', async () => {
  const config = (await createProductionChildConfig(productionChildOptions())).config
  const root = {
    phiSessionId: childScope.phiSessionId,
    projectId: childScope.projectId,
    cwd: childScope.cwd,
    generation: childScope.generation,
    rootAgentId: childScope.rootAgentId,
    rootOmpSessionId: childScope.rootOmpSessionId,
    rootSessionFile: childScope.rootSessionFile
  }
  const call = {
    parentRunId: 'parent',
    controlSequence: 1,
    toolCallId: 'task',
    inputDigest: 'a'.repeat(64),
    declaredTaskCount: 3,
    expectedTaskCount: 3,
    dispatchSealed: false
  }
  const pending = makeRpcTaskLaunchReceipt(config, root, call)
  assert.deepEqual(parseRpcTaskLaunchReceipt(JSON.stringify(pending), config, root), pending)
  const sealed = makeRpcTaskLaunchReceipt(config, root, {
    ...call,
    expectedTaskCount: 2,
    dispatchSealed: true
  })
  assert.equal(
    parseRpcTaskLaunchReceipt(JSON.stringify(sealed), config, root)?.expectedTaskCount,
    2
  )
  assert.equal(
    parseRpcTaskLaunchReceipt(JSON.stringify({ ...sealed, expectedTaskCount: 0 }), config, root),
    undefined
  )
  assert.equal(
    parseRpcTaskLaunchReceipt(JSON.stringify(sealed), config, { ...root, generation: 2 }),
    undefined
  )
  assert.throws(() => makeRpcTaskLaunchReceipt(config, root, { ...call, expectedTaskCount: 2 }))
  assert.throws(() =>
    makeRpcTaskLaunchReceipt(config, root, {
      ...call,
      declaredTaskCount: 33,
      expectedTaskCount: 33
    })
  )
})
