import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  evaluateDecision,
  listDecisionModels
} from '../../src/main/agent/engine/in-process/decision-backend'
import {
  getContext,
  modelRuntimeSnapshot
} from '../../src/main/agent/engine/in-process/runtime-context'
import { contexts, sessions, type SessionEntry } from '../../src/main/agent/engine/in-process/state'
import type { DecisionRequest } from '../../src/shared/decisionTypes'

const agentDir = process.env.PI_CODING_AGENT_DIR
if (!agentDir || !process.env.PHI_DECISION_FIXTURE) throw new Error('Disposable profile required')
const request: DecisionRequest = {
  purpose: 'task_routing',
  context: 'A supplied request that must only be classified.',
  question: 'Choose whether to proceed or defer.',
  options: [
    { id: 'proceed', description: 'Enough evidence to continue' },
    { id: 'defer', description: 'More evidence is required' }
  ]
}
const chat = { providerId: 'phi-decision-chat', modelId: 'current-chat' }
const native = { providerId: 'phi-decision-native', modelId: 'selected-jev' }
const input = { agentDir, sessionId: 'decision-fixture', model: chat, judgeModel: native, request }
const providerSessionId = 'sdk-provider-session'
const providerRequests: Array<{
  path: string
  body: Record<string, unknown>
  key?: string
  configuredHeader?: string | string[]
}> = []
const active = new Set<ServerResponse>()
let answer: unknown = {
  type: 'choice',
  choice: 'defer',
  probabilities: { proceed: 0.2, defer: 0.8 },
  confidence: 0.6
}
let nativeStatus = 200
let nativeHold = false
let chatHold = false
let chatText = 'proceed'
let rejectChat = false
let afterNativeResponse: (() => void) | undefined
let onNativeRequest: (() => void) | undefined
let onChatRequest: (() => void) | undefined
const server = createServer(async (incoming, response) => {
  active.add(response)
  response.on('close', () => active.delete(response))
  let raw = ''
  for await (const chunk of incoming) raw += chunk
  const body = JSON.parse(raw) as Record<string, unknown>
  const path = incoming.url ?? ''
  providerRequests.push({
    path,
    body,
    key: incoming.headers.authorization,
    configuredHeader: incoming.headers['x-decision-fixture']
  })
  if (path === '/v1/systemone') {
    onNativeRequest?.()
    if (nativeHold) return
    response.writeHead(nativeStatus, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify(
        nativeStatus === 200
          ? {
              model: body.model,
              answers: { decision: answer },
              usage: { input_tokens: 7, output_tokens: 1, cost: 0.001 }
            }
          : { error: 'secret-provider-diagnostic' }
      )
    )
    afterNativeResponse?.()
    return
  }
  if (path === '/v1/chat/completions') {
    onChatRequest?.()
    if (rejectChat) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'secret-provider-diagnostic' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (delta: unknown, finish: string | null = null): void => {
      response.write(
        `data: ${JSON.stringify({ id: 'decision-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      )
    }
    emit({ role: 'assistant', content: chatText })
    if (chatHold) return
    emit({}, 'stop')
    response.write(
      `data: ${JSON.stringify({ id: 'decision-fixture', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } })}\n\n`
    )
    response.end('data: [DONE]\n\n')
    return
  }
  response.writeHead(404).end()
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const model = (id: string): Record<string, unknown> => ({
  id,
  name: id,
  input: ['text'],
  reasoning: false,
  contextWindow: 8192,
  maxTokens: 4096,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
})
await writeFile(
  join(agentDir, 'models.yml'),
  JSON.stringify({
    providers: {
      [native.providerId]: {
        api: 'typesafe',
        baseUrl,
        apiKey: 'fixture-native-credential',
        headers: { 'X-Decision-Fixture': 'native-header' },
        models: [
          { ...model(native.modelId), kind: 'judge' },
          { ...model('other-jev'), kind: 'judge' }
        ]
      },
      'phi-decision-unconfigured': {
        api: 'typesafe',
        baseUrl,
        auth: 'oauth',
        models: [{ ...model('unconfigured-jev'), kind: 'judge' }]
      },
      [chat.providerId]: {
        api: 'openai-completions',
        baseUrl: `${baseUrl}/v1`,
        auth: 'none',
        headers: { 'X-Decision-Fixture': 'chat-header' },
        models: [{ ...model(chat.modelId), compat: { supportsPromptCacheKey: true } }]
      }
    }
  })
)
const ctx = await getContext(agentDir)
assert.equal(ctx.modelRegistry.getError(), undefined)
const authScopes: Array<{ method: 'key' | 'resolver'; sessionId: unknown }> = []
const getApiKey = ctx.modelRegistry.getApiKey.bind(ctx.modelRegistry)
let afterAuth: (() => void) | undefined
ctx.modelRegistry.getApiKey = async (model, sessionId, options) => {
  authScopes.push({ method: 'key', sessionId })
  const key = await getApiKey(model, sessionId, options)
  afterAuth?.()
  return key
}
const resolver = ctx.modelRegistry.resolver
Object.defineProperty(ctx.modelRegistry, 'resolver', {
  value(...args: unknown[]) {
    authScopes.push({ method: 'resolver', sessionId: args[1] })
    return Reflect.apply(resolver, ctx.modelRegistry, args)
  }
})
const metadataCalls: string[] = []
const ledger: Array<{
  usage: { input: number }
  api: string
  stopReason: string
  errorMessage?: string
}> = []
// The session/ledger sink is synthetic; registry observers still invoke the real SDK methods.
const localSession = {
  result: {
    session: {
      agent: {
        sessionId: providerSessionId,
        metadataForProvider: (provider: string) => {
          assert.equal(authScopes.at(-1)?.sessionId, providerSessionId)
          metadataCalls.push(provider)
          return { user_id: JSON.stringify({ session_id: providerSessionId }) }
        }
      },
      sessionManager: {
        getSessionId: () => 'ledger-session',
        getLeafId: () => 'ledger-leaf',
        appendModelUsage: (entry: (typeof ledger)[number], owner: unknown) => {
          assert.deepEqual(owner, { sessionId: 'ledger-session', parentId: 'ledger-leaf' })
          ledger.push(entry)
        }
      }
    }
  }
} as unknown as SessionEntry
sessions.set(input.sessionId, localSession)
let checks = 0
const check = (name: string): void => {
  checks++
  process.stdout.write(`${name}\n`)
}
const nativeCount = (): number =>
  providerRequests.filter((entry) => entry.path === '/v1/systemone').length
const chatCount = (): number =>
  providerRequests.filter((entry) => entry.path === '/v1/chat/completions').length
try {
  const models = await listDecisionModels(agentDir)
  assert.ok(
    models.some(
      (entry) =>
        entry.providerId === native.providerId &&
        entry.modelId === native.modelId &&
        entry.configured
    )
  )
  assert.ok(
    models.some((entry) => entry.providerId === 'phi-decision-unconfigured' && !entry.configured)
  )
  assert.ok(models.every((entry) => entry.providerId !== chat.providerId))
  const snapshot = (await modelRuntimeSnapshot({ agentDir })) as {
    providers: Array<{ id: string }>
    models: Array<{ provider: string }>
  }
  assert.ok(snapshot.providers.some((provider) => provider.id === native.providerId))
  assert.ok(snapshot.models.every((model) => model.provider !== native.providerId))
  check('discovers native judges including unconfigured models')

  const result = await evaluateDecision(input, new AbortController().signal)
  assert.deepEqual(result, { choice: 'defer', source: 'native', model: native, confidence: 0.6 })
  assert.equal(providerRequests[0].body.model, native.modelId)
  assert.equal(providerRequests[0].key, 'Bearer fixture-native-credential')
  assert.equal(providerRequests[0].configuredHeader, 'native-header')
  assert.deepEqual(providerRequests[0].body.state, {
    purpose: request.purpose,
    context: request.context
  })
  assert.equal(chatCount(), 0)
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].usage.input, 7)
  check('uses the exact selected native model, registry credentials and usage ledger')

  const beforeUnconfigured = nativeCount()
  const noNative = await evaluateDecision(
    { ...input, judgeModel: null },
    new AbortController().signal
  )
  assert.deepEqual(noNative, {
    choice: 'proceed',
    source: 'model',
    model: chat,
    fallbackReason: 'not_configured'
  })
  assert.equal(nativeCount(), beforeUnconfigured)
  assert.equal(ledger.length, 2)
  assert.equal(ledger[1].usage.input, 9)
  assert.equal(providerRequests.at(-1)?.body.model, chat.modelId)
  assert.equal(providerRequests.at(-1)?.configuredHeader, 'chat-header')
  assert.equal(providerRequests.at(-1)?.body.prompt_cache_key, providerSessionId)
  assert.deepEqual(metadataCalls, [chat.providerId])
  check(
    'unconfigured judgments directly use the current chat model without synthetic confidence or double billing'
  )

  for (const judgeModel of [
    { providerId: 'missing-provider', modelId: 'missing' },
    { providerId: 'phi-decision-unconfigured', modelId: 'unconfigured-jev' },
    chat
  ]) {
    assert.equal(
      (await evaluateDecision({ ...input, judgeModel }, new AbortController().signal))
        .fallbackReason,
      'unavailable'
    )
  }
  assert.equal(nativeCount(), beforeUnconfigured)
  check('unavailable and non-judgment selections fall back without invoking another native model')

  const valid = answer
  for (const malformed of [
    {
      type: 'choice',
      choice: 'invented',
      probabilities: { proceed: 0.2, defer: 0.8 },
      confidence: 0.6
    },
    { type: 'choice', choice: 'defer', probabilities: { proceed: 0.2 }, confidence: 0.6 },
    {
      type: 'choice',
      choice: 'defer',
      probabilities: { proceed: null, defer: 1 },
      confidence: 0.6
    },
    { type: 'choice', choice: 'defer', probabilities: { proceed: 0.2, defer: 0.8 }, confidence: 2 },
    {
      type: 'choice',
      choice: 'defer',
      probabilities: { proceed: 0.8, defer: 0.2 },
      confidence: 0.6
    },
    {
      type: 'choice',
      choice: 'defer',
      probabilities: { proceed: 0.2, defer: 0.2 },
      confidence: 0.6
    }
  ]) {
    answer = malformed
    const before = chatCount()
    const fallback = await evaluateDecision(input, new AbortController().signal)
    assert.equal(fallback.source, 'model')
    assert.equal(fallback.fallbackReason, 'unavailable')
    assert.equal(chatCount(), before + 1)
  }
  answer = valid
  check(
    'rejects unknown choices, incomplete/non-finite/unnormalized distributions and invalid confidence'
  )

  nativeStatus = 400
  assert.equal(
    (await evaluateDecision(input, new AbortController().signal)).fallbackReason,
    'unavailable'
  )
  nativeStatus = 200
  check('native transport failures fall back once')

  const beforeAbort = chatCount()
  const controller = new AbortController()
  nativeHold = true
  onNativeRequest = () => controller.abort(new DOMException('Stopped by Phi', 'AbortError'))
  await assert.rejects(evaluateDecision(input, controller.signal), { name: 'AbortError' })
  onNativeRequest = undefined
  nativeHold = false
  assert.equal(chatCount(), beforeAbort)
  check('caller cancellation stops native transport without starting fallback')

  const stale = new AbortController()
  afterNativeResponse = () => stale.abort(new DOMException('Run stopped', 'AbortError'))
  await assert.rejects(evaluateDecision(input, stale.signal), { name: 'AbortError' })
  afterNativeResponse = undefined
  assert.equal(chatCount(), beforeAbort)
  check('a response arriving after cancellation cannot be accepted')

  const chatAbort = new AbortController()
  chatHold = true
  onChatRequest = () => chatAbort.abort(new DOMException('Stopped by Phi', 'AbortError'))
  await assert.rejects(evaluateDecision({ ...input, judgeModel: null }, chatAbort.signal), {
    name: 'AbortError'
  })
  chatHold = false
  onChatRequest = undefined
  check('caller cancellation also stops chat fallback')

  chatText = 'unknown-label'
  const beforeInvalid = chatCount()
  const beforeLedger = ledger.filter((entry) => entry.stopReason === 'stop').length
  await assert.rejects(
    evaluateDecision({ ...input, judgeModel: null }, new AbortController().signal),
    { message: 'Decision evaluation failed' }
  )
  assert.equal(chatCount() - beforeInvalid, 3)
  assert.equal(ledger.filter((entry) => entry.stopReason === 'stop').length - beforeLedger, 3)
  chatText = 'proceed'
  check('unparseable chat output fails safely and every SDK parse attempt is counted once')

  rejectChat = true
  await assert.rejects(
    evaluateDecision({ ...input, judgeModel: null }, new AbortController().signal),
    { message: 'Decision evaluation failed' }
  )
  assert.ok(ledger.every((entry) => entry.errorMessage === undefined))
  rejectChat = false
  check('provider errors never escape into Phi results or the session ledger')

  nativeHold = true
  const started = Date.now()
  const bounded = await evaluateDecision(input, AbortSignal.timeout(20_000))
  assert.equal(bounded.fallbackReason, 'unavailable')
  assert.ok(Date.now() - started >= 11_500 && Date.now() - started < 16_000)
  nativeHold = false
  check('native attempts have a separate bounded budget and preserve time for chat fallback')

  const blocked = new AbortController()
  blocked.abort(new DOMException('Overall deadline', 'TimeoutError'))
  const beforeBlocked = providerRequests.length
  await assert.rejects(evaluateDecision(input, blocked.signal), { name: 'TimeoutError' })
  assert.equal(providerRequests.length, beforeBlocked)
  check('expired overall budgets do not start any provider request')

  const beforeMetadata = metadataCalls.length
  afterAuth = () =>
    sessions.set(input.sessionId, {
      result: {
        session: {
          agent: {
            sessionId: 'successor-provider-session',
            metadataForProvider: () => {
              throw new Error('Metadata belongs to a successor session')
            }
          }
        }
      }
    } as unknown as SessionEntry)
  nativeStatus = 400
  assert.equal((await evaluateDecision(input, new AbortController().signal)).source, 'model')
  afterAuth = undefined
  nativeStatus = 200
  sessions.set(input.sessionId, localSession)
  assert.ok(authScopes.some((scope) => scope.method === 'key'))
  assert.ok(authScopes.some((scope) => scope.method === 'resolver'))
  assert.ok(authScopes.every((scope) => scope.sessionId === providerSessionId))
  assert.equal(providerRequests.at(-1)?.body.prompt_cache_key, providerSessionId)
  assert.equal(metadataCalls.length, beforeMetadata + 1)
  check(
    'native and fallback capture one SDK provider identity and metadata despite session replacement'
  )

  const remoteSessionId = 'remote-phi-runtime-session'
  const beforeRemoteAuth = authScopes.length
  const beforeRemoteMetadata = metadataCalls.length
  const beforeRemoteLedger = ledger.length
  await evaluateDecision(
    { ...input, sessionId: remoteSessionId, judgeModel: null },
    new AbortController().signal
  )
  assert.ok(authScopes.slice(beforeRemoteAuth).length >= 2)
  assert.ok(
    authScopes.slice(beforeRemoteAuth).every((scope) => scope.sessionId === remoteSessionId)
  )
  assert.equal(providerRequests.at(-1)?.body.prompt_cache_key, remoteSessionId)
  assert.equal(metadataCalls.length, beforeRemoteMetadata)
  assert.equal(ledger.length, beforeRemoteLedger)
  check('remote evaluation retains its Phi identity without borrowing local metadata or ledger')
  process.stdout.write(`PASS ${checks} decision backend checks\n`)
} finally {
  sessions.delete(input.sessionId)
  contexts.clear()
  ctx.authStorage.close()
  for (const response of active) response.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
