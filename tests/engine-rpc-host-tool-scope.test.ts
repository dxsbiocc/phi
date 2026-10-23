import assert from 'node:assert/strict'
import test from 'node:test'
import type { PhiTool } from '../src/main/agent/engine/types'
import { hostToolsForModelRoutes } from '../src/main/agent/engine/rpc/host-tool-validation'

test('Cursor native generations omit browser while other model routes retain it', () => {
  const browser = { name: 'browser' } as PhiTool
  const memory = { name: 'memory' } as PhiTool
  const tools = [browser, memory]
  assert.strictEqual(hostToolsForModelRoutes(tools, [{ provider: 'moonshot', id: 'model' }]), tools)
  assert.deepEqual(
    hostToolsForModelRoutes(tools, [{ provider: 'cursor', id: 'cursor-grok-4.6-fast' }]),
    [memory]
  )
})
