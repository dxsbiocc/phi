import assert from 'node:assert/strict'
import test from 'node:test'
import {
  jupyterServerIsStarting,
  pollJupyterServerStartupStatus
} from '../src/renderer/src/features/runtime/lib/jupyterStatusPolling'
import type { JupyterServerStatus } from '../src/renderer/src/types'

function status(state: JupyterServerStatus['state'], hasEndpoint = false): JupyterServerStatus {
  return {
    projectCwd: '/project',
    state,
    hasEndpoint
  }
}

test('jupyter startup polling refreshes starting status until ready', async () => {
  const updates: JupyterServerStatus[] = []
  const reads = [status('starting'), status('ready', true)]

  const finalStatus = await pollJupyterServerStartupStatus({
    cwd: '/project',
    initialStatus: status('starting'),
    attempts: 5,
    intervalMs: 0,
    delay: async () => undefined,
    shouldContinue: () => true,
    readStatus: async () => reads.shift() ?? status('ready', true),
    onStatus: (nextStatus) => {
      updates.push(nextStatus)
    }
  })

  assert.equal(finalStatus.state, 'ready')
  assert.equal(finalStatus.hasEndpoint, true)
  assert.deepEqual(
    updates.map((item) => item.state),
    ['starting', 'ready']
  )
})

test('jupyter startup polling stops when the caller becomes stale', async () => {
  let readCount = 0
  const finalStatus = await pollJupyterServerStartupStatus({
    cwd: '/project',
    initialStatus: status('starting'),
    attempts: 5,
    intervalMs: 0,
    delay: async () => undefined,
    shouldContinue: () => false,
    readStatus: async () => {
      readCount += 1
      return status('ready', true)
    },
    onStatus: () => undefined
  })

  assert.equal(finalStatus.state, 'starting')
  assert.equal(readCount, 0)
})

test('jupyterServerIsStarting treats local and remote startup phases as pollable', () => {
  for (const state of [
    'starting',
    'preparing_environment',
    'allocating_ports',
    'starting_lease',
    'probing_through_tunnel',
    'cleaning'
  ] as const) {
    assert.equal(jupyterServerIsStarting(status(state)), true, state)
  }
  assert.equal(jupyterServerIsStarting(status('ready', true)), false)
  assert.equal(jupyterServerIsStarting(status('error')), false)
})
