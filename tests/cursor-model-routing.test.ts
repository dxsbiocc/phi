import assert from 'node:assert/strict'
import test from 'node:test'

import { cursorModelWithBridge } from '../src/main/agent/omp/cursor-model-routing'

test('bundled Cursor models use the local HTTP/2 bridge without mutating the catalog', async () => {
  const model = { provider: 'cursor', id: 'grok-4.6-fast', baseUrl: 'https://api2.cursor.sh' }
  const routed = await cursorModelWithBridge(model, async () => 'http://127.0.0.1:34567')
  assert.equal(routed?.baseUrl, 'http://127.0.0.1:34567')
  assert.equal(model.baseUrl, 'https://api2.cursor.sh')
})

test('custom Cursor endpoints and other providers retain their configured URL', async () => {
  const fail = async (): Promise<string> => {
    throw new Error('bridge should not start')
  }
  const custom = { provider: 'cursor', baseUrl: 'http://127.0.0.1:8080' }
  assert.equal(await cursorModelWithBridge(custom, fail), custom)
  const customPath = { provider: 'cursor', baseUrl: 'https://api2.cursor.sh/custom' }
  assert.equal(await cursorModelWithBridge(customPath, fail), customPath)
  const other = { provider: 'openai', baseUrl: 'https://api.openai.com' }
  assert.equal(await cursorModelWithBridge(other, fail), other)
})

test('Cursor bridge URL must stay on loopback', async () => {
  await assert.rejects(
    cursorModelWithBridge(
      { provider: 'cursor', baseUrl: 'https://api2.cursor.sh' },
      async () => 'http://0.0.0.0:8080'
    ),
    /桥接不可用/
  )
})
