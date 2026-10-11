import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearManagedEnvironmentCache,
  readManagedEnvironmentCache,
  refreshManagedEnvironmentCache,
  writeManagedEnvironmentCache
} from '../src/renderer/src/features/environment/lib/managedEnvironmentApi'
import type { ManagedEnvironmentEntry } from '../src/shared/environmentTypes'

const environment: ManagedEnvironmentEntry = {
  ref: 'phi:jupyter@1',
  envId: 'phi-jupyter-0123456789ab',
  state: 'absent',
  source: 'official',
  referrers: [],
  consumers: []
}

test('managed environment results survive settings-panel remounts per project', () => {
  clearManagedEnvironmentCache()
  writeManagedEnvironmentCache('/workspace/one', [environment])

  assert.deepEqual(readManagedEnvironmentCache('/workspace/one'), [environment])
  assert.equal(readManagedEnvironmentCache('/workspace/two'), undefined)
})

test('concurrent remount refreshes share one expensive catalog request', async () => {
  clearManagedEnvironmentCache()
  let calls = 0
  let finish: ((value: ManagedEnvironmentEntry[]) => void) | undefined
  const loader = (): Promise<ManagedEnvironmentEntry[]> => {
    calls += 1
    return new Promise((resolve) => {
      finish = resolve
    })
  }

  const first = refreshManagedEnvironmentCache('/workspace/one', loader)
  const second = refreshManagedEnvironmentCache('/workspace/one', loader)
  assert.equal(calls, 1)

  finish?.([environment])
  assert.deepEqual(await first, [environment])
  assert.deepEqual(await second, [environment])
})
