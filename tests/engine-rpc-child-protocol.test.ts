import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalRpcChildNativeInput } from '../src/main/agent/engine/phi-extension/extensions/rpc-child-native-tools'
import { test } from 'node:test'
import {
  createRpcChildCall,
  encodeRpcChildRequest,
  hasReservedRpcChildUri,
  MAX_RPC_CHILD_REPLY_BYTES,
  MAX_RPC_CHILD_REQUEST_BYTES,
  parseRpcChildReply,
  parseRpcChildRequest,
  parseRpcChildUri,
  projectRpcChildModel,
  projectRpcChildRoute,
  validateRpcChildModel,
  validateRpcChildRoute,
  rpcChildPromptDigest,
  rpcChildUri,
  sameRpcChildRoot,
  sameRpcChildScope,
  snapshotRpcChildProfile,
  validateRpcChildActual,
  validateRpcChildRoot,
  validateRpcChildScope,
  type RpcChildRequest,
  type RpcChildScope,
  type RpcChildTrustedProfile
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'

const root = Object.freeze({
  phiSessionId: 'phi-session',
  projectId: 'project',
  cwd: '/srv/project',
  generation: 1,
  rootAgentId: 'Main',
  rootOmpSessionId: 'sdk-root',
  rootSessionFile: '/srv/history/root.jsonl'
})
const scope: RpcChildScope = Object.freeze({
  ...root,
  nativeAgentId: 'child-1',
  childOmpSessionId: 'sdk-child',
  childSessionFile: '/srv/history/root/child-1.jsonl',
  parentSession: root.rootSessionFile,
  nativeName: 'phi_compiled_0_fg',
  definitionHash: 'a'.repeat(64)
})
const trustedModel = {
  provider: 'fixture',
  id: 'model',
  reasoning: false,
  input: ['text'] as const,
  contextWindow: 32768,
  maxTokens: 1024
}
const route = {
  api: 'openai-completions' as const,
  baseUrl: 'http://127.0.0.1:12345',
  transport: 'sse' as const
}
const profile: RpcChildTrustedProfile = {
  definition: {
    definitionHash: scope.definitionHash,
    phiName: 'Research',
    nativeName: scope.nativeName,
    blocking: true,
    tools: [{ name: 'write', site: 'native' }],
    skills: [],
    model: { provider: 'fixture', id: 'model' },
    thinkingLevel: 'off'
  },
  systemPrompt: ['Trusted exact prompt'],
  expectedAgentSource: 'user',
  model: trustedModel,
  route
}
const actual = {
  tools: ['write'],
  model: profile.model,
  route: profile.route,
  systemPromptDigest: rpcChildPromptDigest(profile.systemPrompt),
  thinkingLevel: 'off'
}
function request(operation: RpcChildRequest['operation'] = 'register'): RpcChildRequest {
  const base = {
    schema: 1 as const,
    id: randomUUID(),
    sequence: operation === 'register' ? 1 : 2,
    capability: 'b'.repeat(64),
    scope
  }
  if (operation === 'activate') return { ...base, operation, actual }
  if (operation === 'approve' || operation === 'execute' || operation === 'result_consumed')
    return {
      ...base,
      operation,
      ...(operation === 'result_consumed' ? { invocationId: randomUUID() } : {}),
      call: createRpcChildCall(scope, 'outer-call', 'write', {
        path: 'result.txt',
        content: 'Approved exact bytes'
      })
    } as RpcChildRequest
  if (operation === 'cancel') return { ...base, operation, targetId: randomUUID() }
  return { ...base, operation }
}
function invalid(value: unknown): void {
  assert.throws(() => parseRpcChildRequest(JSON.stringify(value)))
}

test('private child requests round-trip their exact typed operation and bounded public reply', () => {
  for (const operation of ['register', 'activate', 'approve', 'cancel'] as const) {
    const sent = request(operation)
    const parsed = parseRpcChildRequest(encodeRpcChildRequest(sent))
    assert.deepEqual(parsed, sent)
    assert.ok(Object.isFrozen(parsed))
    if (sent.operation !== 'cancel') {
      for (const allowed of [false, true])
        assert.deepEqual(
          parseRpcChildReply(
            JSON.stringify({ schema: 1, id: sent.id, operation, sequence: sent.sequence, allowed }),
            sent
          ),
          { schema: 1, id: sent.id, operation, sequence: sent.sequence, allowed }
        )
    }
  }
})

test('wire identity is structurally exact and never grants authority by itself', () => {
  assert.deepEqual(validateRpcChildRoot(root), root)
  assert.deepEqual(validateRpcChildScope(scope), scope)
  assert.ok(sameRpcChildRoot(scope, root))
  assert.equal(sameRpcChildScope(scope, { ...scope, generation: 2 }), false)
  for (const changed of [
    { cwd: '/srv/../project' },
    { parentSession: '/srv/history/other.jsonl' },
    { nativeAgentId: 'Main' },
    { childOmpSessionId: 'sdk-root' },
    { childSessionFile: '/srv/history/../other.jsonl' },
    { generation: 0 },
    { definitionHash: 'x'.repeat(64) },
    { injectedRunId: 'model-run' }
  ])
    invalid({ ...request(), scope: { ...scope, ...changed } })
  for (const changed of [
    { schema: 2 },
    { id: 'model-id' },
    { sequence: 0 },
    { sequence: 1.2 },
    { capability: 'nonce' },
    { extra: true },
    { operation: 'host' }
  ])
    invalid({ ...request(), ...changed })
})

test('approval digest binds the full scope, outer call identity and immutable effective JSON input', () => {
  const input = { path: 'result.txt', nested: { second: 2, first: 1 }, content: 'Ω🧬' }
  const call = createRpcChildCall(scope, 'outer-call', 'write', input)
  const reordered = createRpcChildCall(scope, 'outer-call', 'write', {
    content: 'Ω🧬',
    nested: { first: 1, second: 2 },
    path: 'result.txt'
  })
  assert.equal(call.inputDigest, reordered.inputDigest)
  input.nested.first = 99
  assert.equal((call.input.nested as { first: number }).first, 1)
  assert.ok(Object.isFrozen(call.input.nested))
  const sent = { ...request('approve'), call }
  for (const mutated of [
    { ...sent, scope: { ...scope, nativeAgentId: 'child-2' } },
    { ...sent, scope: { ...scope, generation: 2 } },
    { ...sent, call: { ...call, toolCallId: 'another-outer-call' } },
    { ...sent, call: { ...call, toolName: 'bash' } },
    { ...sent, call: { ...call, input: { path: 'other.txt' } } },
    { ...sent, call: { ...call, extra: 'untrusted' } }
  ])
    invalid(mutated)
})

test('JSON-only input validation does not execute accessors and refuses cycles, unsafe keys and bounds', () => {
  let getterHits = 0
  const accessor = Object.defineProperty({}, 'path', {
    enumerable: true,
    get: () => {
      getterHits++
      return 'phi-child://reply/test'
    }
  })
  assert.throws(() => createRpcChildCall(scope, 'outer', 'read', accessor))
  assert.equal(hasReservedRpcChildUri(accessor), true)
  assert.equal(getterHits, 0)
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  assert.throws(() => createRpcChildCall(scope, 'outer', 'write', cycle))
  assert.equal(hasReservedRpcChildUri(cycle), true)
  assert.throws(() =>
    createRpcChildCall(scope, 'outer', 'write', JSON.parse('{"__proto__":{"allowed":true}}'))
  )
  assert.throws(() => parseRpcChildRequest(' '.repeat(MAX_RPC_CHILD_REQUEST_BYTES + 1)))
  assert.throws(() =>
    createRpcChildCall(scope, 'outer', 'write', {
      content: 'x'.repeat(MAX_RPC_CHILD_REQUEST_BYTES)
    })
  )
})

test('private URLs contain only an exact UUID, never capability, query or self-reported scope', () => {
  const id = randomUUID()
  for (const part of ['request', 'reply', 'cancel'] as const) {
    const url = rpcChildUri(part, id)
    assert.deepEqual(parseRpcChildUri(url), { part, id })
    assert.equal(url.includes('b'.repeat(64)), false)
    for (const invalidUrl of [
      url + '?capability=secret',
      url + '#scope',
      url + '/',
      url.replace('phi-child:', 'PHI-CHILD:'),
      url.replace('//', '//user@')
    ])
      assert.throws(() => parseRpcChildUri(invalidUrl))
  }
  assert.throws(() => rpcChildUri('request', 'model-chosen-id'))
  invalid({ ...request('cancel'), targetId: 'unbounded' })
})

test('reserved control URLs are refused across model-reachable input fields and encoded spellings', () => {
  for (const input of [
    { path: 'phi-child://reply/' + randomUUID() },
    { command: 'read PHI-CHILD://reply/x' },
    { edits: [{ replacement: '%70hi-child%3A//reply/x' }] },
    { params: ['%2570hi-child%253A//reply/x'] },
    { 'phi-child://request/x': 'ignored' }
  ])
    assert.equal(hasReservedRpcChildUri(input), true)
  assert.equal(
    hasReservedRpcChildUri({ path: 'results.txt', content: 'ordinary user data' }),
    false
  )
})

test('activation replies require explicit boolean decisions and exact request identity', () => {
  const sent = request('activate')
  assert.equal(sent.operation, 'activate')
  if (sent.operation !== 'activate') return
  const reply = {
    schema: 1,
    id: sent.id,
    operation: sent.operation,
    sequence: sent.sequence,
    allowed: true
  }
  for (const changed of [
    { allowed: 'true' },
    { id: randomUUID() },
    { sequence: 99 },
    { operation: 'approve' },
    { extra: true }
  ])
    assert.throws(() => parseRpcChildReply(JSON.stringify({ ...reply, ...changed }), sent))
  for (const malformed of ['null', '[]', '{broken', ' '.repeat(MAX_RPC_CHILD_REPLY_BYTES + 1)])
    assert.throws(() => parseRpcChildReply(malformed, sent))
})

test('trusted profile snapshot rejects unverified resources, invalid execution mode, missing thinking and silent subsets', () => {
  const snapshot = snapshotRpcChildProfile(profile)
  assert.ok(Object.isFrozen(snapshot.definition.tools))
  assert.deepEqual(snapshot, profile)
  for (const definition of [
    { ...profile.definition, blocking: 'background' },
    { ...profile.definition, skills: ['unverified'] },
    { ...profile.definition, environment: { ref: 'unverified' } },
    { ...profile.definition, tools: [{ name: 'ChildHost', site: 'host' }] },
    { ...profile.definition, tools: [{ name: 'task', site: 'native' }] },
    { ...profile.definition, tools: [] },
    { ...profile.definition, thinkingLevel: undefined },
    { ...profile.definition, thinkingLevel: 'auto' }
  ])
    assert.throws(() =>
      snapshotRpcChildProfile({ ...profile, definition } as RpcChildTrustedProfile)
    )
  for (const name of ['edit', 'grep'])
    assert.equal(
      snapshotRpcChildProfile({
        ...profile,
        definition: { ...profile.definition, tools: [{ name, site: 'native' }] }
      }).definition.tools[0].name,
      name
    )
  assert.equal(
    snapshotRpcChildProfile({ ...profile, definition: { ...profile.definition, blocking: false } })
      .definition.blocking,
    false
  )
  assert.throws(() =>
    snapshotRpcChildProfile({
      ...profile,
      expectedAgentSource: 'project'
    } as unknown as RpcChildTrustedProfile)
  )
  assert.throws(() => validateRpcChildActual({ ...actual, tools: ['write', 'write'] }))
  assert.throws(() =>
    validateRpcChildActual({
      ...actual,
      model: { provider: 'fixture', id: 'model', apiKey: 'forbidden' }
    })
  )
})

test('R6a native file input binds ordinary project paths and denies URI routing, selectors and aliases', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-child-path-')))
  const cwd = join(root, 'project')
  await mkdir(cwd, { mode: 0o700 })
  await writeFile(join(cwd, 'source.txt'), 'Private text', { mode: 0o600 })
  await writeFile(join(root, 'outside.txt'), 'Outside project', { mode: 0o600 })
  await writeFile(join(cwd, 'image.png'), 'Not a verified text resource', { mode: 0o600 })
  await symlink(join(root, 'outside.txt'), join(cwd, 'escape.txt'))
  try {
    assert.equal(
      canonicalRpcChildNativeInput(cwd, 'read', { path: 'source.txt' }).path,
      join(cwd, 'source.txt') + ':raw'
    )
    assert.equal(
      canonicalRpcChildNativeInput(cwd, 'write', { path: 'new.txt', content: 'Approved bytes' })
        .path,
      join(cwd, 'new.txt')
    )
    for (const path of [
      'agent://Main',
      'phi-child://request/' + randomUUID(),
      'source.txt:1-4',
      'source.txt?summary',
      '../outside.txt',
      'escape.txt',
      'missing.txt',
      'image.png',
      'source\u00a0.txt',
      "source'file.txt"
    ])
      assert.throws(() => canonicalRpcChildNativeInput(cwd, 'read', { path }))
    for (const path of [
      'agent://Main',
      'phi-chlid://request/x',
      '../outside.txt',
      'source.txt:selector'
    ])
      assert.throws(() =>
        canonicalRpcChildNativeInput(cwd, 'write', { path, content: 'No effect' })
      )
    assert.equal(
      canonicalRpcChildNativeInput(cwd, 'read', { path: join(cwd, 'source.txt') + ':raw' }).path,
      join(cwd, 'source.txt') + ':raw'
    )
    await symlink(join(root, 'outside.txt'), join(cwd, 'source.txt:raw'))
    assert.throws(() => canonicalRpcChildNativeInput(cwd, 'read', { path: 'source.txt' }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('known model metadata and owned route are required, without getters or authentication overrides', () => {
  assert.deepEqual(validateRpcChildModel(trustedModel), trustedModel)
  assert.deepEqual(validateRpcChildRoute(route), route)
  for (const patch of [
    { contextWindow: null },
    { maxTokens: null },
    { contextWindow: 0 },
    { maxTokens: Infinity },
    { input: ['text', 'text'] },
    { reasoning: 'yes' }
  ]) {
    assert.throws(() => validateRpcChildModel({ ...trustedModel, ...patch }))
    assert.throws(() =>
      snapshotRpcChildProfile({
        ...profile,
        model: { ...trustedModel, ...patch }
      } as RpcChildTrustedProfile)
    )
  }
  for (const patch of [
    { api: 'anthropic-messages' },
    { transport: 'websocket' },
    { baseUrl: 'https://api.example.com' },
    { baseUrl: route.baseUrl + '/extra' },
    { baseUrl: route.baseUrl + '/?key=secret' }
  ])
    assert.throws(() => validateRpcChildRoute({ ...route, ...patch }))
  const model = { ...trustedModel, ...route, name: 'Actual model', cost: {} }
  assert.deepEqual(projectRpcChildModel(model), trustedModel)
  assert.deepEqual(projectRpcChildRoute(model), route)
  assert.throws(() =>
    projectRpcChildRoute({ ...model, headers: { authorization: 'must not be copied' } })
  )
  assert.throws(() => projectRpcChildRoute({ ...model, apiKey: 'must not be copied' }))
  let hits = 0
  assert.throws(() =>
    projectRpcChildModel(
      Object.defineProperty({ ...model }, 'maxTokens', {
        get: () => {
          hits++
          return 1024
        }
      })
    )
  )
  assert.equal(hits, 0)
})
