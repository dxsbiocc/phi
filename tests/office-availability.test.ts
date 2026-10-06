import assert from 'node:assert/strict'
import test from 'node:test'

import {
  officeAvailabilityArgument,
  parseOfficeAvailabilityArguments,
  UNAVAILABLE_OFFICE_AVAILABILITY,
  type OfficeAvailability
} from '../src/shared/officeAvailability'
import {
  OfficeAvailabilityCache,
  computeOfficeAvailability
} from '../src/main/agent/office/office-availability'
import type { OfficeRuntimeStatus } from '../src/main/agent/office/office-runtime'
import { officeTestHooksEnabled } from '../src/main/agent/office/office-test-hooks'

const availableRuntime: OfficeRuntimeStatus = {
  state: 'available',
  binaryPath: '/runtime/officecli',
  version: '1.0.153',
  platform: 'darwin-arm64'
}

test('Office availability arguments round-trip and malformed values fail closed', () => {
  const availability: OfficeAvailability = {
    supported: true,
    userEnabled: true,
    enabled: true,
    reason: null
  }

  assert.deepEqual(
    parseOfficeAvailabilityArguments([officeAvailabilityArgument(availability)]),
    availability
  )
  assert.deepEqual(parseOfficeAvailabilityArguments([]), UNAVAILABLE_OFFICE_AVAILABILITY)
  assert.deepEqual(
    parseOfficeAvailabilityArguments(['--phi-office-availability=%7Bbroken']),
    UNAVAILABLE_OFFICE_AVAILABILITY
  )
})

test('Office availability combines platform, runtime, preference, and forced disable', () => {
  assert.deepEqual(computeOfficeAvailability({ runtime: availableRuntime, userEnabled: true }), {
    supported: true,
    userEnabled: true,
    enabled: true,
    reason: null
  })
  assert.deepEqual(computeOfficeAvailability({ runtime: availableRuntime, userEnabled: false }), {
    supported: true,
    userEnabled: false,
    enabled: false,
    reason: 'user-disabled'
  })
  assert.deepEqual(
    computeOfficeAvailability({
      runtime: availableRuntime,
      userEnabled: true,
      forcedDisabled: true
    }),
    { supported: true, userEnabled: true, enabled: false, reason: 'forced-disabled' }
  )
  assert.deepEqual(
    computeOfficeAvailability({
      runtime: { state: 'unsupported-platform', platform: 'linux-x64' },
      userEnabled: true
    }),
    { supported: false, userEnabled: true, enabled: false, reason: 'unsupported-platform' }
  )
  assert.deepEqual(
    computeOfficeAvailability({
      runtime: { state: 'missing', expectedPath: '/runtime/officecli', hint: 'fetch' },
      userEnabled: true
    }),
    { supported: true, userEnabled: true, enabled: false, reason: 'runtime-missing' }
  )
  for (const runtime of [
    { state: 'checksum-mismatch', binaryPath: '/runtime/officecli' },
    {
      state: 'version-mismatch',
      binaryPath: '/runtime/officecli',
      expected: '1.0.153',
      found: '1.0.152'
    },
    { state: 'incompatible', binaryPath: '/runtime/officecli', missing: ['batch --input'] },
    { state: 'unusable', binaryPath: '/runtime/officecli', reason: 'failed' }
  ] satisfies OfficeRuntimeStatus[]) {
    assert.equal(
      computeOfficeAvailability({ runtime, userEnabled: true }).reason,
      'runtime-invalid'
    )
  }
})

test('Office availability probes once and skips OfficeCLI when disabled', async () => {
  for (const input of [
    { userEnabled: false, forcedDisabled: false },
    { userEnabled: true, forcedDisabled: true }
  ]) {
    let probes = 0
    const cache = new OfficeAvailabilityCache()
    const first = await cache.initialize({
      ...input,
      platform: 'darwin',
      arch: 'arm64',
      detectRuntime: async () => {
        probes += 1
        return availableRuntime
      }
    })
    const second = await cache.initialize({
      ...input,
      platform: 'darwin',
      arch: 'arm64',
      detectRuntime: async () => {
        probes += 1
        return availableRuntime
      }
    })

    assert.equal(probes, 0)
    assert.equal(first, second)
    assert.equal(first.enabled, false)
  }
})

test('Office availability caches one runtime probe and one unavailable log', async () => {
  let probes = 0
  const reasons: string[] = []
  const cache = new OfficeAvailabilityCache()
  const options = {
    userEnabled: true,
    forcedDisabled: false,
    platform: 'darwin',
    arch: 'arm64',
    detectRuntime: async (): Promise<OfficeRuntimeStatus> => {
      probes += 1
      return { state: 'missing', expectedPath: '/runtime/officecli', hint: 'fetch' }
    },
    onUnavailable: (reason: string): void => {
      reasons.push(reason)
    }
  }

  const first = await cache.initialize(options)
  const second = await cache.initialize(options)

  assert.equal(first, second)
  assert.equal(probes, 1)
  assert.deepEqual(reasons, ['runtime-missing'])
  assert.deepEqual(cache.get(), first)
  assert.throws(() => cache.getRuntime(), /Office runtime is unavailable/)
})

test('unsupported platforms are cached without starting OfficeCLI', async () => {
  let probes = 0
  const cache = new OfficeAvailabilityCache()
  const availability = await cache.initialize({
    userEnabled: true,
    forcedDisabled: false,
    platform: 'win32',
    arch: 'x64',
    detectRuntime: async () => {
      probes += 1
      return availableRuntime
    }
  })

  assert.equal(probes, 0)
  assert.deepEqual(availability, {
    supported: false,
    userEnabled: true,
    enabled: false,
    reason: 'unsupported-platform'
  })
})

test('Office test hooks require the explicit flag and are always off when packaged', () => {
  assert.equal(officeTestHooksEnabled(false, {}), false)
  assert.equal(officeTestHooksEnabled(false, { PHI_OFFICE_TEST_HOOKS: '0' }), false)
  assert.equal(officeTestHooksEnabled(false, { PHI_OFFICE_TEST_HOOKS: '1' }), true)
  assert.equal(officeTestHooksEnabled(true, { PHI_OFFICE_TEST_HOOKS: '1' }), false)
})
