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
  'decisions.evaluate',
  'libraryTool.execute',
  'palette.suggest',
  'memory.read',
  'memory.learn',
  'memory.ingest',
  'memory.deleteLesson',
  'memory.clear',
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
  'mcp.desktop.list',
  'mcp.desktop.call',
  'mcp.desktop.cancel',
  'mcp.desktop.close',
  'modelAccess.credentials',
  'modelAccess.refresh',
  'cursorBridge.ensure',
  'capabilities.search',
  'capabilities.install',
  'capabilities.findSkills',
  'capabilities.cancel',
  'wrapperCatalog.search',
  'wrapperCatalog.inspect',
  'wrapperJob.start',
  'wrapperJob.status',
  'wrapperJob.list',
  'wrapperJob.cancel',
  'wrapperJob.wait',
  'agentRun.finished',
  'agentRun.step',
  'agentRun.reported',
  'agentRun.nativeTaskStarted',
  'agentRun.nativeTaskBackground',
  'agentRun.nativeTaskStep',
  'agentRun.nativeTaskFinished'
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
  'capabilities.install',
  'wrapperJob.start'
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
    assert.ok(
      typeof definition.runScoped === 'boolean' || definition.runScoped === 'optional',
      name
    )
  }
  assert.equal(KERNEL_HOST_CAPABILITY_REGISTRY['environments.bindSession'].runScoped, 'optional')
  assert.equal(KERNEL_HOST_CAPABILITY_REGISTRY['mcp.desktop.call'].progress, true)
})

test('wrapper start is user-interactive because missing tools pause for a chat card', () => {
  assert.equal(KERNEL_HOST_CAPABILITY_REGISTRY['wrapperJob.start'].interaction, 'user')
  assert.equal('timeoutMs' in KERNEL_HOST_CAPABILITY_REGISTRY['wrapperJob.start'], false)
})

test('environment requests carry the optional local binding marker', () => {
  const { params } = KERNEL_HOST_CAPABILITY_REGISTRY['environments.request']
  const request = {
    runtimeSessionId: 'bound-session',
    cwd: '/tmp/phi-project',
    packages: ['numpy'],
    reason: 'Rebind the environment',
    environment: 'env-base'
  }
  const bound = { ...request, boundSession: true }
  assert.deepEqual(params.parse(bound), bound)
  const remote = { ...request, remoteSessionId: 'remote-session', projectId: 'project' }
  assert.deepEqual(params.parse(remote), remote)
  assert.equal(params.safeParse({ ...request, boundSession: 'true' }).success, false)
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

  const modelCredentials = KERNEL_HOST_CAPABILITY_REGISTRY['modelAccess.credentials']
  const modelRefresh = KERNEL_HOST_CAPABILITY_REGISTRY['modelAccess.refresh']
  assert.equal(modelCredentials.sensitiveResult, true)
  assert.equal(modelRefresh.sensitiveResult, true)
  const oauth = {
    id: 7,
    provider: 'fake-oauth',
    credential: {
      type: 'oauth' as const,
      access: 'fake-access-token',
      refresh: '__remote__',
      expires: Date.now() + 60_000
    },
    identityKey: null
  }
  assert.equal(modelCredentials.result.safeParse({ credentials: [oauth] }).success, true)
  assert.equal(modelRefresh.result.safeParse(oauth).success, true)

  const wrapperSearch = KERNEL_HOST_CAPABILITY_REGISTRY['wrapperCatalog.search']
  const wrapperInspect = KERNEL_HOST_CAPABILITY_REGISTRY['wrapperCatalog.inspect']
  assert.equal(wrapperSearch.params.safeParse({ query: '' }).success, true)
  assert.equal(wrapperSearch.params.safeParse({ query: 'x'.repeat(501) }).success, false)
  assert.equal(wrapperSearch.params.safeParse({ query: 42 }).success, false)
  assert.equal(wrapperInspect.params.safeParse({ id: 'nf-core/modules/fastqc' }).success, true)
  assert.equal(wrapperInspect.params.safeParse({ id: '' }).success, false)
  assert.equal(wrapperInspect.params.safeParse({ id: 'x'.repeat(513) }).success, false)
})

test('native task notice schemas keep card identity and bounded lifecycle payloads', () => {
  const common = {
    originSessionId: 'kernel-session-1',
    nativeTaskId: 'native-child-1',
    agent: 'task'
  }
  assert.equal(
    KERNEL_HOST_CAPABILITY_REGISTRY['agentRun.nativeTaskStarted'].params.safeParse({
      ...common,
      task: 'Read README.md',
      parentToolCallId: 'outer-task'
    }).success,
    true
  )
  assert.equal(
    KERNEL_HOST_CAPABILITY_REGISTRY['agentRun.nativeTaskStep'].params.safeParse({
      ...common,
      step: { id: 'read-1', toolName: 'read', status: 'done' }
    }).success,
    true
  )
  const stepSchema = KERNEL_HOST_CAPABILITY_REGISTRY['agentRun.nativeTaskStep'].params
  for (const step of [
    {},
    { id: 'read-1', toolName: 'read', status: 'done', undeclared: true },
    { id: 'x'.repeat(513), toolName: 'read', status: 'done' },
    { id: 'read-1', toolName: '', status: 'done' },
    { id: 'read-1', toolName: 'read', status: 'completed' },
    { id: 'read-1', toolName: 'read', status: 'done', output: 'x'.repeat(512 * 1024 + 1) },
    { id: 'read-1', toolName: 'read', status: 'done', createdAt: 'x'.repeat(65) },
    { id: 'read-1', toolName: 'read', status: 'done', durationMs: -1 }
  ]) {
    assert.equal(stepSchema.safeParse({ ...common, step }).success, false)
  }
  assert.equal(
    KERNEL_HOST_CAPABILITY_REGISTRY['agentRun.nativeTaskFinished'].params.safeParse({
      ...common,
      state: 'done',
      report: '# Phi',
      durationMs: 1250,
      toolCalls: 2
    }).success,
    true
  )
  assert.equal(
    KERNEL_HOST_CAPABILITY_REGISTRY['agentRun.nativeTaskFinished'].params.safeParse({
      ...common,
      state: 'completed'
    }).success,
    false
  )
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
