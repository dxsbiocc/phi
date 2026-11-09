import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPlanSessionLoader } from '../src/main/agent/plan/plan-session-loader'

const localRef = {
  kind: 'phi-kernel' as const,
  version: 1 as const,
  kernelSessionId: 'kernel-1',
  host: { kind: 'local' as const, agentDir: '/agent' }
}

function harness(
  overrides: {
    current?: string
    ref?: unknown
    unfinished?: number
    currentAgentDir?: string
  } = {}
): { load: (id: string) => Promise<boolean>; loads: string[]; lookups: string[] } {
  const loads: string[] = []
  const lookups: string[] = []
  const load = createPlanSessionLoader({
    currentPhiSessionId: () => overrides.current ?? 'phi-1',
    kernelRuntimeRef: (id) =>
      (id === 'phi-1' ? (overrides.ref === undefined ? localRef : overrides.ref) : undefined) as
        typeof localRef | undefined,
    currentAgentDir: () => overrides.currentAgentDir ?? '/current-agent',
    unfinishedPlanRunCount: (kernelSessionId, agentDir) => {
      lookups.push(`${kernelSessionId}@${agentDir}`)
      return overrides.unfinished ?? 1
    },
    loadCurrentSession: async () => {
      loads.push('load')
    }
  })
  return { load, loads, lookups }
}

test('an open conversation with an unfinished local plan loads its kernel session', async () => {
  const { load, loads, lookups } = harness()
  assert.equal(await load('phi-1'), true)
  assert.deepEqual(loads, ['load'])
  assert.deepEqual(lookups, ['kernel-1@/current-agent'])
})

test('a moved recorded agent directory counts plan runs in the current agent directory', async () => {
  const { load, loads, lookups } = harness({
    ref: { ...localRef, host: { kind: 'local', agentDir: '/recorded-old-agent' } },
    currentAgentDir: '/current-new-agent'
  })
  assert.equal(await load('phi-1'), true)
  assert.deepEqual(loads, ['load'])
  assert.deepEqual(lookups, ['kernel-1@/current-new-agent'])
})

test('a local ref without a recorded agent directory still looks in the current one', async () => {
  const { load, lookups } = harness({
    ref: { ...localRef, host: { kind: 'local' } },
    currentAgentDir: '/current-new-agent'
  })
  assert.equal(await load('phi-1'), true)
  assert.deepEqual(lookups, ['kernel-1@/current-new-agent'])
})

test('no load without an unfinished plan, for another conversation, or for remote hosts', async () => {
  for (const options of [
    { unfinished: 0 },
    { current: 'phi-2' },
    { ref: null },
    { ref: { ...localRef, host: { kind: 'ssh', hostProfileId: 'gpu' } } }
  ]) {
    const { load, loads } = harness(options)
    assert.equal(await load('phi-1'), false, JSON.stringify(options))
    assert.deepEqual(loads, [])
  }
})

test('concurrent requests for the same conversation share one load', async () => {
  const { load, loads } = harness()
  const results = await Promise.all([load('phi-1'), load('phi-1')])
  assert.deepEqual(results, [true, true])
  assert.deepEqual(loads, ['load'])
})
