import assert from 'node:assert/strict'
import test from 'node:test'

import {
  KERNEL_HOST_CAPABILITIES,
  KERNEL_HOST_CAPABILITY_REGISTRY,
  interactionCancelledPayloadSchema,
  isKernelHostCapabilityName
} from '../src/shared/kernel-protocol'

const EXPECTED_CAPABILITIES = [
  'agentInteraction.request',
  'planReview.request',
  'browser.execute',
  'browser.cancel',
  'deliverables.present',
  'notebookTool.execute',
  'environments.bindSession',
  'environments.request',
  'environments.cancel',
  'workMode.selected',
  'settings.nextActionSuggestionsEnabled',
  'skills.scriptTools',
  'skills.run',
  'skills.scriptTool',
  'skills.cancel',
  'mcp.featuredApiKey',
  'mcp.openAuthUrl',
  'mcp.openCustomAuthUrl',
  'cursorBridge.ensure',
  'capabilities.search',
  'capabilities.install',
  'capabilities.findSkills',
  'capabilities.cancel',
  'wrapperJob.start',
  'wrapperJob.status',
  'wrapperJob.list',
  'wrapperJob.cancel',
  'wrapperJob.wait',
  'agentRun.finished',
  'agentRun.step',
  'agentRun.reported'
] as const

const EXPECTED_USER_CAPABILITIES = new Set([
  'agentInteraction.request',
  'planReview.request',
  'browser.execute',
  'notebookTool.execute',
  'environments.bindSession',
  'environments.request',
  'skills.run',
  'skills.scriptTool',
  'capabilities.install'
])

test('host capability registry covers every current worker request', () => {
  assert.deepEqual(KERNEL_HOST_CAPABILITIES, EXPECTED_CAPABILITIES)
  assert.deepEqual(Object.keys(KERNEL_HOST_CAPABILITY_REGISTRY), [...EXPECTED_CAPABILITIES])
  for (const name of EXPECTED_CAPABILITIES) assert.equal(isKernelHostCapabilityName(name), true)
  assert.equal(isKernelHostCapabilityName('desktop.unregistered'), false)
})

test('host capability interaction metadata has bounded service timeouts', () => {
  for (const [name, definition] of Object.entries(KERNEL_HOST_CAPABILITY_REGISTRY)) {
    assert.equal(
      definition.interaction,
      EXPECTED_USER_CAPABILITIES.has(name) ? 'user' : 'service',
      name
    )
    if (definition.interaction === 'service') {
      assert.equal(Number.isSafeInteger(definition.timeoutMs), true)
      assert.ok(definition.timeoutMs > 0)
    } else {
      assert.equal('timeoutMs' in definition, false)
    }
    assert.equal(typeof definition.runScoped, 'boolean')
  }
})

test('host capability schemas reject undeclared fields and protect credential results', () => {
  const settings = KERNEL_HOST_CAPABILITY_REGISTRY['settings.nextActionSuggestionsEnabled']
  assert.equal(settings.params.safeParse({}).success, true)
  assert.equal(settings.params.safeParse({ surprise: true }).success, false)
  assert.equal(settings.result.safeParse(true).success, true)
  assert.equal(settings.result.safeParse('true').success, false)

  const credential = KERNEL_HOST_CAPABILITY_REGISTRY['mcp.featuredApiKey']
  assert.equal(credential.sensitiveResult, true)
  assert.equal(credential.result.safeParse('secret').success, true)
  assert.equal(credential.result.safeParse(null).success, true)
  assert.equal(credential.result.safeParse({ key: 'secret' }).success, false)
})

test('plan review and interaction cancellation schemas retain run identity', () => {
  const review = KERNEL_HOST_CAPABILITY_REGISTRY['planReview.request']
  assert.equal(
    review.params.safeParse({
      runtimeSessionId: 'runtime-1',
      title: 'Review this plan',
      planContent: '# Plan',
      planFilePath: 'local://PLAN.md'
    }).success,
    true
  )
  assert.equal(review.interaction, 'user')
  assert.equal(review.runScoped, true)

  assert.deepEqual(
    interactionCancelledPayloadSchema.parse({
      kind: 'host',
      id: 'host-1',
      sessionId: 'session-1',
      runId: 'run-1',
      reason: 'run ended'
    }),
    {
      kind: 'host',
      id: 'host-1',
      sessionId: 'session-1',
      runId: 'run-1',
      reason: 'run ended'
    }
  )
})
