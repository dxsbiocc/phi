import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorkerSubsystemRegistry } from '../src/main/agent/engine/in-process/worker-subsystems'

test('worker subsystem cleanup loads nothing after a session-only path', async () => {
  const loaded: string[] = []
  const closed: string[] = []
  const registry = createWorkerSubsystemRegistry({
    decision: async () => {
      loaded.push('decision')
      return {
        close: () => {
          closed.push('decision')
        }
      }
    },
    mcp: async () => {
      loaded.push('mcp')
      return {
        close: async () => {
          closed.push('mcp')
        }
      }
    },
    memory: async () => {
      loaded.push('memory')
      return {
        close: async () => {
          closed.push('memory')
        }
      }
    },
    modelGateway: async () => {
      loaded.push('modelGateway')
      return {
        close: async () => {
          closed.push('modelGateway')
        }
      }
    }
  })

  await registry.closeLoaded()
  assert.deepEqual(loaded, [])
  assert.deepEqual(closed, [])
  assert.deepEqual(registry.loaded(), [])
})

test('worker subsystem cleanup closes only a subsystem that was used', async () => {
  const loaded: string[] = []
  const closed: string[] = []
  const registry = createWorkerSubsystemRegistry({
    decision: async () => {
      loaded.push('decision')
      return {
        close: () => {
          closed.push('decision')
        }
      }
    },
    mcp: async () => {
      loaded.push('mcp')
      return {
        close: async () => {
          closed.push('mcp')
        }
      }
    },
    memory: async () => {
      loaded.push('memory')
      return {
        close: async () => {
          closed.push('memory')
        }
      }
    },
    modelGateway: async () => {
      loaded.push('modelGateway')
      return {
        close: async () => {
          closed.push('modelGateway')
        }
      }
    }
  })

  const first = await registry.load('mcp')
  const second = await registry.load('mcp')
  assert.equal(first, second)
  await registry.closeLoaded()

  assert.deepEqual(loaded, ['mcp'])
  assert.deepEqual(closed, ['mcp'])
  assert.deepEqual(registry.loaded(), ['mcp'])
})
