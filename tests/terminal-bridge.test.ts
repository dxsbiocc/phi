import assert from 'node:assert/strict'
import test from 'node:test'

import type { TerminalRendererBridge } from '../src/shared/terminalTypes'
import { isTerminalBridgeAvailable } from '../src/renderer/src/features/terminal/lib/terminalBridge'

const bridgeMethods = [
  'list',
  'create',
  'attach',
  'input',
  'resize',
  'ack',
  'close',
  'generateDraft',
  'cancelDraft',
  'submitDraft',
  'onEvent'
] as const satisfies readonly (keyof TerminalRendererBridge)[]

function completeBridge(): TerminalRendererBridge {
  return {
    list: async () => ({ ok: true, value: [] }),
    create: async () => {
      throw new Error('not used')
    },
    attach: async () => {
      throw new Error('not used')
    },
    input: async () => ({ ok: true, value: undefined }),
    resize: async () => ({ ok: true, value: undefined }),
    ack: async () => ({ ok: true, value: undefined }),
    close: async () => ({ ok: true, value: undefined }),
    generateDraft: async () => {
      throw new Error('not used')
    },
    cancelDraft: async () => ({ ok: true, value: undefined }),
    submitDraft: async () => ({ ok: true, value: undefined }),
    onEvent: () => () => undefined
  }
}

test('terminal bridge availability rejects an undefined bridge', () => {
  assert.equal(isTerminalBridgeAvailable(undefined), false)
})

test('terminal bridge availability rejects partial bridges missing any required method', () => {
  const bridge = completeBridge()

  for (const method of bridgeMethods) {
    assert.equal(
      isTerminalBridgeAvailable({ ...bridge, [method]: undefined }),
      false,
      `expected a bridge missing ${method} to be unavailable`
    )
  }
})

test('terminal bridge availability accepts a complete renderer bridge', () => {
  assert.equal(isTerminalBridgeAvailable(completeBridge()), true)
})
