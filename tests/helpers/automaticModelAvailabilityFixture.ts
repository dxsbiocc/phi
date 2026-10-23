import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  evaluateDecisionRequest,
  closeDecisionRuntime
} from '../../src/main/agent/engine/in-process/decision-runtime'
import {
  getContext,
  modelRuntimeSnapshot
} from '../../src/main/agent/engine/in-process/runtime-context'
import {
  createAgentSession,
  makeSessionManager,
  SettingsManager
} from '../../src/main/agent/engine/in-process/session-factory'
import { createSessionModelAvailability } from '../../src/main/agent/engine/in-process/session-model-availability'
import { createPhiAgentSession } from '../../src/main/agent/engine/in-process/subagents'
import type { PhiAgentDefinition } from '../../src/main/agent/agents/definition'
import {
  readModelAvailability,
  writeModelAvailabilityChange
} from '../../src/main/agent/model-availability'
import type { DecisionRequest } from '../../src/shared/decisionTypes'

const agentDir = process.env.PI_CODING_AGENT_DIR
if (!agentDir || !process.env.PHI_AVAILABILITY_FIXTURE)
  throw new Error('Disposable profile required')
const chatProvider = 'phi-auto-chat'
const nativeProvider = 'phi-auto-judge'
const model = (id: string): Record<string, unknown> => ({
  id,
  name: id,
  reasoning: false,
  input: ['text'],
  contextWindow: 131072,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
})
const request: DecisionRequest = {
  purpose: 'evidence_review',
  context: 'Fixture evidence',
  question: 'Proceed?',
  options: [
    { id: 'proceed', description: 'Enough evidence' },
    { id: 'uncertain', description: 'More evidence required' }
  ]
}
const input = {
  agentDir,
  sessionId: 'auto-phi-session',
  model: { providerId: chatProvider, modelId: 'enabled' },
  request
}
const requests: Array<{ path: string; model: string }> = []
const active = new Set<ServerResponse>()
let nativeHook: (() => void) | undefined
let chatHook: (() => void) | undefined
let holdChat = false
let finishChat: (() => void) | undefined
const server = createServer(async (incoming, response) => {
  active.add(response)
  response.on('close', () => active.delete(response))
  if (incoming.method !== 'POST') {
    response.writeHead(404).end()
    return
  }
  let raw = ''
  for await (const chunk of incoming) raw += chunk
  const body = JSON.parse(raw) as { model: string }
  requests.push({ path: incoming.url!, model: body.model })
  if (incoming.url === '/v1/systemone') {
    nativeHook?.()
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        model: body.model,
        answers: {
          decision: {
            type: 'choice',
            choice: 'proceed',
            probabilities: { proceed: 0.8, uncertain: 0.2 },
            confidence: 0.6
          }
        }
      })
    )
    return
  }
  if (incoming.url !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }
  chatHook?.()
  if (body.model === 'failing') {
    response
      .writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'Synthetic model unavailable' } }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (delta: unknown, finish: string | null = null): void => {
    response.write(
      `data: ${JSON.stringify({ id: 'auto-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    )
  }
  emit({ role: 'assistant', content: 'proceed' })
  const finish = (): void => {
    emit({}, 'stop')
    response.end('data: [DONE]\n\n')
  }
  if (holdChat) finishChat = finish
  else finish()
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
await writeFile(
  join(agentDir, 'models.yml'),
  JSON.stringify({
    providers: {
      typesafe: {
        api: 'typesafe',
        baseUrl,
        auth: 'oauth',
        models: [{ ...model('jev-latest'), kind: 'judge' }]
      },
      [nativeProvider]: {
        api: 'typesafe',
        baseUrl,
        auth: 'oauth',
        models: ['jev-latest', 'jev-1.0', 'other-native'].map((id) => ({
          ...model(id),
          kind: 'judge'
        }))
      },
      [chatProvider]: {
        api: 'openai-completions',
        baseUrl: `${baseUrl}/v1`,
        auth: 'none',
        models: ['disabled', 'enabled', 'failing'].map(model)
      }
    }
  })
)
await writeFile(
  join(agentDir, 'settings.json'),
  JSON.stringify({ decisionModel: { providerId: nativeProvider, modelId: 'other-native' } })
)
const ctx = await getContext(agentDir)
const sessions: Array<Awaited<ReturnType<typeof createAgentSession>>['session']> = []
const count = (): number => requests.length
let checks = 0
const checked = (label: string): void => {
  checks++
  process.stdout.write(`${label}\n`)
}
const toggle = (providerId: string, enabled: boolean, modelId?: string): void => {
  writeModelAvailabilityChange({ providerId, enabled, ...(modelId ? { modelId } : {}) }, agentDir)
}
const evaluate = (): ReturnType<typeof evaluateDecisionRequest> => evaluateDecisionRequest(input)
const create = async (
  options: { selected?: string; saved?: string; fallback?: boolean } = {}
): ReturnType<typeof createAgentSession> => {
  const manager = await makeSessionManager({ kind: 'memory' }, agentDir, agentDir)
  if (options.saved) {
    manager.appendModelChange(`${chatProvider}/${options.saved}`)
    manager.appendMessage({ role: 'user', content: 'Restored history', timestamp: Date.now() })
  }
  const settings = SettingsManager.inMemory().overlay({
    modelRoles: { default: `${chatProvider}/disabled` },
    'retry.modelFallback': Boolean(options.fallback),
    'retry.fallbackOn': 'any',
    'retry.fallbackChains': { default: [`${chatProvider}/disabled`, `${chatProvider}/enabled`] },
    'retry.baseDelayMs': 1,
    'retry.maxDelayMs': 1,
    'compaction.enabled': false,
    'memories.enabled': false
  })
  const result = await createAgentSession({
    cwd: agentDir,
    agentDir,
    settings,
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    sessionManager: manager,
    ...(options.selected ? { model: ctx.modelRegistry.find(chatProvider, options.selected)! } : {}),
    enableMCP: false,
    enableLsp: false,
    disableExtensionDiscovery: true,
    toolNames: [],
    restrictToolNames: true,
    contextFiles: [],
    skills: [],
    promptTemplates: [],
    slashCommands: []
  })
  sessions.push(result.session)
  return result
}
try {
  assert.equal((await evaluate()).source, 'model')
  checked('unconfigured native providers use the exact current model and ignore legacy manual pins')
  const snapshot = (await modelRuntimeSnapshot({ agentDir })) as {
    providers: Array<{ id: string; modelKinds: string[] }>
    models: Array<{ provider: string }>
  }
  assert.deepEqual(
    snapshot.providers.find((provider) => provider.id === nativeProvider)?.modelKinds,
    ['decision']
  )
  assert.ok(
    snapshot.models.every(
      (item) => item.provider !== nativeProvider && item.provider !== 'typesafe'
    )
  )
  checked(
    'unconfigured decision providers remain visible while native models stay out of the chat catalog'
  )

  await ctx.auth.setApiKey(nativeProvider, 'fixture-native-key')
  assert.deepEqual((await evaluate()).model, { providerId: nativeProvider, modelId: 'jev-latest' })
  assert.deepEqual((await evaluate()).model, { providerId: nativeProvider, modelId: 'jev-latest' })
  toggle(nativeProvider, false, 'jev-latest')
  assert.equal((await evaluate()).model.modelId, 'jev-1.0')
  toggle(nativeProvider, true, 'jev-latest')
  checked(
    'stable JEV alias wins deterministically and disabling it selects another enabled native model'
  )

  toggle(nativeProvider, false)
  assert.equal((await evaluate()).source, 'model')
  assert.ok(ctx.auth.credentialStatus(nativeProvider).available)
  toggle(nativeProvider, true)
  assert.equal((await evaluate()).source, 'native')
  checked(
    'provider disable and re-enable take effect on the next decision without deleting credentials'
  )

  nativeHook = () => toggle(nativeProvider, false)
  assert.equal((await evaluate()).source, 'native')
  nativeHook = undefined
  assert.equal((await evaluate()).source, 'model')
  toggle(nativeProvider, true)
  await ctx.auth.logout(nativeProvider)
  assert.equal((await evaluate()).source, 'model')
  await ctx.auth.setApiKey(nativeProvider, 'fixture-native-key')
  checked(
    'inflight native choice stays fixed while subsequent calls observe policy and auth changes'
  )

  await ctx.auth.setApiKey('typesafe', 'fixture-typesafe-key')
  assert.ok(
    ctx.modelRegistry
      .getAvailable('judge')
      .filter((item) => item.provider === 'typesafe')
      .every((item) => item.baseUrl === baseUrl)
  )
  assert.deepEqual((await evaluate()).model, { providerId: 'typesafe', modelId: 'jev-latest' })
  toggle('typesafe', false, 'jev-latest')
  assert.deepEqual((await evaluate()).model, { providerId: nativeProvider, modelId: 'jev-latest' })
  checked('official TypeSafe stable alias wins and another stable alias precedes versioned natives')

  toggle(nativeProvider, false)
  toggle('typesafe', false)
  toggle(chatProvider, false)
  const beforeDisabled = count()
  await assert.rejects(evaluate(), /Decision evaluation failed/)
  assert.equal(count(), beforeDisabled)
  toggle(chatProvider, true)
  checked('a disabled current chat model fails safely rather than choosing another LLM')

  toggle(chatProvider, false, 'disabled')
  const scope = createSessionModelAvailability(ctx.modelRegistry, agentDir)
  const disabled = ctx.modelRegistry.find(chatProvider, 'disabled')!
  assert.ok(disabled)
  assert.equal(scope.registry.find(chatProvider, 'disabled'), undefined)
  assert.equal(scope.registry.hasConfiguredAuth(disabled), false)
  assert.ok(scope.registry.getAll().every((item) => item.id !== 'disabled'))
  assert.ok(
    scope.registry
      .getAvailableForProviders(new Set([chatProvider]))
      .every((item) => item.id !== 'disabled')
  )
  await assert.rejects(scope.registry.getApiKey(disabled), /disabled in Phi/)
  await assert.rejects(
    async () =>
      scope.registry.resolver(disabled, 'fixture')({ error: undefined, lastChance: false }),
    /disabled in Phi/
  )
  checked(
    'SDK selection and auth paths cannot resurrect a disabled fallback from a direct model object'
  )

  await assert.rejects(create({ selected: 'disabled' }), /disabled in Phi/)
  const startup = await create()
  assert.notEqual(startup.session.model?.id, 'disabled')
  const restored = await create({ saved: 'disabled' })
  assert.equal(restored.session.model, undefined)
  checked(
    'startup skips disabled defaults and saved disabled selections retain the unavailable restore state'
  )

  const live = await create({ selected: 'enabled' })
  await assert.rejects(live.session.setModel(disabled), /disabled in Phi/)
  let started!: () => void
  const seen = new Promise<void>((resolve) => {
    started = resolve
  })
  holdChat = true
  chatHook = started
  const running = live.session.prompt('Complete the fixture')
  await seen
  toggle(chatProvider, false, 'enabled')
  assert.ok(live.session.modelRegistry.find(chatProvider, 'enabled'))
  assert.equal(live.session.model?.id, 'enabled')
  assert.ok(finishChat)
  finishChat()
  await running
  holdChat = false
  chatHook = undefined
  const beforeNext = count()
  await assert.rejects(live.session.prompt('Next task'), /disabled in Phi/)
  assert.equal(count(), beforeNext)
  toggle(chatProvider, true, 'enabled')
  await live.session.prompt('Re-enabled task')
  checked(
    'active chat keeps its snapshot while the next prompt and idle selection enforce current switches'
  )

  const retrying = await create({ selected: 'failing', fallback: true })
  const beforeRetry = count()
  await retrying.session.prompt('Try configured fallback')
  const attempted = requests.slice(beforeRetry).map((entry) => entry.model)
  assert.ok(attempted.includes('failing'))
  assert.ok(attempted.includes('enabled'))
  assert.ok(!attempted.includes('disabled'))
  checked('actual SDK error recovery skips disabled fallback candidates')

  const definition: PhiAgentDefinition = {
    name: 'Fixture',
    description: 'Fixture specialist',
    tools: [],
    skills: [],
    visibility: 'entry',
    warnings: [],
    systemPrompt: 'Answer the fixture.',
    source: 'phi',
    filePath: join(agentDir, 'fixture.md')
  }
  const specialistOptions = {
    sessionId: 'parent-fixture',
    cwd: agentDir,
    agentDir,
    ctx,
    resourceOptions: undefined,
    enableToolApproval: false,
    parent: () => live
  }
  toggle(chatProvider, false, 'enabled')
  const beforeSdkInit = readModelAvailability(agentDir)
  assert.ok((await readFile(join(agentDir, 'model-availability.json'), 'utf8')).includes('enabled'))
  await assert.rejects(createPhiAgentSession(definition, specialistOptions), /No enabled model/)
  assert.deepEqual(readModelAvailability(agentDir), beforeSdkInit)
  toggle(chatProvider, true, 'enabled')
  const specialist = await createPhiAgentSession(
    { ...definition, model: [`${chatProvider}/disabled`, `${chatProvider}/enabled`] },
    specialistOptions
  )
  try {
    const beforeSpecialist = count()
    await specialist.prompt('Specialist fixture')
    assert.ok(requests.slice(beforeSpecialist).some((entry) => entry.model === 'enabled'))
    assert.ok(requests.slice(beforeSpecialist).every((entry) => entry.model !== 'disabled'))
  } finally {
    await specialist.dispose()
  }
  checked('new specialists reject disabled inheritance and choose enabled declared alternatives')
  process.stdout.write(`PASS ${checks} automatic availability checks\n`)
} finally {
  closeDecisionRuntime()
  for (const session of sessions) await session.dispose()
  ctx.authStorage.close()
  for (const response of active) response.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
