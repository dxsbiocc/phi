import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  childConfigDigest,
  loadRpcChildRuntimeConfig,
  makeRpcChildAttestation,
  validateRpcChildRuntimeConfig,
  validateRpcForegroundTaskInput,
  verifyRpcChildAttestation,
  type RpcChildRuntimeConfig
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-config'
import { executionRoster } from '../src/main/agent/engine/phi-extension/lib/rpc-execution-protocol'
import { childProfile, childScope } from './helpers/rpcChildAuthorityFixture'

const name = 'phi_' + 'a'.repeat(24) + '_0_fg'
const identity = {
  nonce: 'n'.repeat(32),
  phiSessionId: 'session',
  projectId: 'project',
  projectRoot: '/srv/project',
  generation: 1
}
const root = { ...childScope, phiSessionId: identity.phiSessionId, projectId: identity.projectId }
const rootScope = {
  phiSessionId: root.phiSessionId,
  projectId: root.projectId,
  cwd: root.cwd,
  generation: root.generation,
  rootAgentId: root.rootAgentId,
  rootOmpSessionId: root.rootOmpSessionId,
  rootSessionFile: root.rootSessionFile
}
function config(): RpcChildRuntimeConfig {
  return {
    ...identity,
    schema: 1,
    manifestHash: 'b'.repeat(64),
    manifestBinding: {
      serverId: 'server',
      serverIdentitySha256: 'c'.repeat(64),
      projectId: identity.projectId,
      projectRoot: identity.projectRoot
    },
    capability: 'd'.repeat(64),
    profiles: [
      {
        ...structuredClone(childProfile),
        definition: { ...structuredClone(childProfile.definition), nativeName: name }
      }
    ],
    files: [
      { path: `agents/${name}.md`, sha256: 'a'.repeat(64) },
      { path: 'phi-agent-definitions.json', sha256: 'b'.repeat(64) }
    ],
    policy: { mode: 'foreground-native', taskShape: 'single' }
  }
}
test('child sidecar snapshots complete known native profiles and rejects identities, resources and null limits', () => {
  const raw = config(),
    accepted = validateRpcChildRuntimeConfig(raw, identity)
  Object.assign(raw.profiles[0].systemPrompt, { 0: 'changed' })
  assert.equal(accepted.profiles[0].systemPrompt[0], 'trusted-child')
  assert.ok(Object.isFrozen(accepted.profiles[0].definition.tools))
  assert.throws(() => validateRpcChildRuntimeConfig({ ...config(), generation: 2 }, identity))
  assert.throws(() => validateRpcChildRuntimeConfig(config(), identity, [config().capability]))
  for (const patch of [
    { tools: [{ name: 'edit', site: 'native' }] },
    { blocking: false },
    { skills: ['unknown'] },
    { thinkingLevel: undefined }
  ]) {
    const value = config()
    Object.assign(value.profiles[0].definition, patch)
    assert.throws(() => validateRpcChildRuntimeConfig(value, identity))
  }
  const unknown = config()
  Object.assign(unknown.profiles[0].model, { contextWindow: null })
  assert.throws(() => validateRpcChildRuntimeConfig(unknown, identity))
  assert.throws(() =>
    validateRpcChildRuntimeConfig({ ...config(), profileFallback: true }, identity)
  )
  let accessed = false
  const accessor = Object.defineProperty({}, 'schema', {
    enumerable: true,
    get: () => {
      accessed = true
      return 1
    }
  })
  assert.throws(() => validateRpcChildRuntimeConfig(accessor, identity))
  assert.equal(accessed, false)
})
test('foreground task policy requires explicit allowed agent and rejects every extra model/tool/background capability', () => {
  const input = {
    agent: name,
    name: 'child',
    task: 'Do the exact task',
    solutionSpace: 'Use the trusted profile'
  }
  assert.deepEqual(validateRpcForegroundTaskInput(input, config()), input)
  assert.deepEqual(
    validateRpcForegroundTaskInput({ ...input, i: 'short intent' }, config(), {
      allowIntent: true
    }),
    input
  )
  for (const [key, value] of Object.entries({
    model: 'other/model',
    tools: [],
    effort: 'hi',
    background: true,
    detached: true,
    keepAlive: true,
    tasks: [],
    context: 'batch',
    isolated: true,
    outputSchema: {},
    schemaMode: 'strict',
    i: 'intent'
  }))
    assert.throws(() => validateRpcForegroundTaskInput({ ...input, [key]: value }, config()))
  assert.throws(() =>
    validateRpcForegroundTaskInput({ ...input, agent: name.replace('_fg', '_bg') }, config())
  )
  assert.throws(() => validateRpcForegroundTaskInput({ task: 'x', solutionSpace: 'x' }, config()))
  for (const name of ['../escape', 'agent://Main', 'nested.child', 'a'.repeat(33), '控制'])
    assert.throws(() => validateRpcForegroundTaskInput({ ...input, name }, config()))
})
test('native task roster is explicitly opted in and never accepts host task aliases', () => {
  const task = { name: 'task', site: 'native' as const }
  assert.throws(() => executionRoster([task]))
  assert.throws(() => executionRoster([task], { allowNativeTask: false }))
  assert.deepEqual(executionRoster([task], { allowNativeTask: true }).tools, [task])
  for (const allowNativeTask of [false, true])
    assert.throws(() =>
      executionRoster([{ name: 'task', site: 'host', parameters: {} }], { allowNativeTask })
    )
})
test('child attestation authenticates canonical root/profile generation without publishing its key', () => {
  const trusted = validateRpcChildRuntimeConfig(config(), identity)
  const proof = makeRpcChildAttestation(trusted, rootScope)
  const reordered = Object.fromEntries(Object.entries(rootScope).reverse()) as typeof rootScope
  assert.equal(verifyRpcChildAttestation(proof, trusted, reordered), true)
  assert.equal(JSON.stringify(proof).includes(trusted.capability), false)
  assert.equal(proof.configHash, childConfigDigest(trusted))
  for (const patch of [
    { nonce: 'wrong' },
    { manifestHash: '0'.repeat(64) },
    { hmac: '0'.repeat(64) },
    { unsafe: true }
  ])
    assert.equal(verifyRpcChildAttestation({ ...proof, ...patch }, trusted, rootScope), false)
  assert.equal(
    verifyRpcChildAttestation(proof, { ...trusted, capability: 'e'.repeat(64) }, rootScope),
    false
  )
  assert.equal(
    verifyRpcChildAttestation(proof, trusted, { ...rootScope, rootOmpSessionId: 'other' }),
    false
  )
})
test('private child loader preserves default deny, requires declared config and binds exact private compiler file hashes', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'phi-child-config-')))
  try {
    const bootstrap = join(directory, 'bootstrap.json')
    assert.equal(loadRpcChildRuntimeConfig(bootstrap, identity), undefined)
    assert.throws(() => loadRpcChildRuntimeConfig(bootstrap, identity, { required: true }))
    const agentDir = join(directory, 'home/.omp/agent')
    await mkdir(join(agentDir, 'agents'), { recursive: true, mode: 0o700 })
    const raw = config(),
      manifest = Buffer.from('actual compiler manifest bytes'),
      markdown = Buffer.from('actual compiler definition bytes')
    const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
    Object.assign(raw, {
      manifestHash: digest(manifest),
      files: [
        { path: `agents/${name}.md`, sha256: digest(markdown) },
        { path: 'phi-agent-definitions.json', sha256: digest(manifest) }
      ]
    })
    const sidecar = join(directory, 'child-runtime.json'),
      definition = join(agentDir, `agents/${name}.md`)
    await writeFile(sidecar, JSON.stringify(raw), { mode: 0o600 })
    await writeFile(definition, markdown, { mode: 0o600 })
    await writeFile(join(agentDir, 'phi-agent-definitions.json'), manifest, { mode: 0o600 })
    assert.ok(loadRpcChildRuntimeConfig(bootstrap, identity, { required: true }))
    await chmod(sidecar, 0o644)
    assert.throws(() => loadRpcChildRuntimeConfig(bootstrap, identity))
    await chmod(sidecar, 0o600)
    await writeFile(definition, 'tampered')
    assert.throws(() => loadRpcChildRuntimeConfig(bootstrap, identity))
    await rm(definition)
    const alternate = join(agentDir, 'alternate')
    await writeFile(alternate, markdown, { mode: 0o600 })
    await symlink(alternate, definition)
    assert.throws(() => loadRpcChildRuntimeConfig(bootstrap, identity))
    await rm(definition)
    await link(alternate, definition)
    assert.throws(() => loadRpcChildRuntimeConfig(bootstrap, identity))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
