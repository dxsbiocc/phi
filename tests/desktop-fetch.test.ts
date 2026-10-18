import assert from 'node:assert/strict'
import test from 'node:test'

import { desktopFetch } from '../src/main/agent/desktop-fetch'

test('desktopFetch prefers an explicit override', () => {
  const override = (async () => new Response('x')) as typeof fetch
  assert.equal(
    desktopFetch(override, () => {
      throw new Error('Electron must not be loaded when an override is given')
    }),
    override
  )
})

test('desktopFetch uses Electron net.fetch so system proxy settings apply', async () => {
  const calls: string[] = []
  const net = {
    fetch: async function (this: unknown, input: RequestInfo | URL) {
      assert.equal(this, net, 'net.fetch must stay bound to Electron net')
      calls.push(String(input))
      return new Response('ok')
    }
  }
  const fetcher = desktopFetch(undefined, () => ({ net }))
  assert.notEqual(fetcher, globalThis.fetch)
  await fetcher('https://example.test/asset')
  assert.deepEqual(calls, ['https://example.test/asset'])
})

test('desktopFetch falls back to the global fetch outside Electron', () => {
  assert.equal(
    desktopFetch(undefined, () => {
      throw new Error('Cannot find module electron')
    }),
    globalThis.fetch
  )
  assert.equal(
    desktopFetch(undefined, () => '/path/to/electron'),
    globalThis.fetch
  )
})
