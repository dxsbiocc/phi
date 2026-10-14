import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  deriveProductionChildBinding,
  createProductionChildConfig,
  publishProductionChildConfig,
  assertPreparedProductionChildConfig
} from '../src/main/agent/engine/rpc/subagents/production-child-config'
import { loadRpcChildRuntimeConfig } from '../src/main/agent/engine/phi-extension/lib/rpc-child-config'
import type { RemoteWorkspaceHostBinding } from '../src/main/agent/remote-workspace-boundary'
import type { RpcRuntimePreparationContext } from '../src/main/agent/engine/rpc/ssh-stdio-factory'
import { prepareRemoteSessionStorageFixture } from './helpers/remoteSessionStorageFixture'
import { productionChildOptions } from './helpers/productionChildNodeFixture'
import { definition } from './helpers/rpcAgentDefinitionFixture'

test('child deployment binding cross-checks actual selected profile/project configuration, never alias-only identity', () => {
  const cacheKey = JSON.stringify([
    'host-profile',
    '/srv/project',
    '/srv/project',
    { hostAlias: 'ssh-alias', user: 'user' }
  ])
  const bindingHash = createHash('sha256').update(cacheKey).digest('hex')
  const actual: RemoteWorkspaceHostBinding = {
    sessionId: 'phi-session',
    projectId: 'project',
    hostAlias: 'ssh-alias',
    remoteRoot: '/srv/project',
    canonicalRoot: '/srv/project',
    cacheKey,
    config: {
      remoteRoot: '/srv/project',
      canonicalRoot: '/srv/project',
      connect: async () => {
        throw new Error('No SSH in unit test')
      }
    }
  }
  const selected = {
    hostProfileId: 'host-profile',
    bindingHash,
    projectId: 'project',
    projectRoot: '/srv/project'
  }
  assert.deepEqual(deriveProductionChildBinding(actual, selected), {
    serverId: 'host-profile',
    serverIdentitySha256: bindingHash,
    projectId: 'project',
    projectRoot: '/srv/project'
  })
  for (const change of [
    { hostProfileId: 'ssh-alias' },
    { bindingHash: 'a'.repeat(64) },
    { projectId: 'other' },
    { projectRoot: '/srv/other' }
  ])
    assert.throws(
      () => deriveProductionChildBinding(actual, { ...selected, ...change }),
      /binding differs/
    )
})

test('trusted compiler preserves full source manifest but publishes only foreground native profiles and known parent route', async () => {
  const options = productionChildOptions()
  const prepared = await createProductionChildConfig(options)
  assert.equal(prepared.config.profiles.length, 1)
  const [profile] = prepared.config.profiles
  assert.equal(profile.definition.blocking, true)
  assert.equal(profile.definition.thinkingLevel, 'off')
  assert.deepEqual(profile.definition.tools.map((tool) => tool.name).sort(), [
    'bash',
    'read',
    'write'
  ])
  assert.equal(profile.route.transport, 'pi-native')
  assert.equal(prepared.config.files.length, 2)
  assert.ok(prepared.config.files.every((file) => !file.path.endsWith('_bg.md')))
  assert.ok(!JSON.stringify(prepared.config).includes(options.definitions[0].filePath))
  assert.ok(Object.isFrozen(prepared.config.profiles[0].model))
  assertPreparedProductionChildConfig(prepared)
  assert.throws(
    () => assertPreparedProductionChildConfig({ config: prepared.config }),
    /not issued/
  )
})

test('unsupported resources, recursive/host tools and nullable limits reject the entire child profile', async () => {
  const good = productionChildOptions()
  const base = good.definitions[0]
  for (const change of [
    { skills: ['a-skill'] },
    { environment: 'system:python' },
    { tools: ['edit'] },
    { tools: ['task'] },
    { tools: ['web_search'] },
    { warnings: ['unknown key'] }
  ])
    await assert.rejects(
      createProductionChildConfig({ ...good, definitions: [{ ...base, ...change }] })
    )
  for (const change of [{ contextWindow: null }, { maxTokens: null }, { contextWindow: 0 }])
    await assert.rejects(
      createProductionChildConfig({
        ...good,
        modelDescriptors: [{ ...good.modelDescriptors[0], ...change }]
      }),
      /Unverifiable/
    )
})

test('child model fallback and selecting a different available model both reject', async () => {
  const good = productionChildOptions()
  await assert.rejects(
    createProductionChildConfig({
      ...good,
      definitions: [definition({ ...good.definitions[0], model: ['missing/model'] })]
    }),
    /fallback/
  )
  await assert.rejects(
    createProductionChildConfig({
      ...good,
      modelDescriptors: [...good.modelDescriptors, { ...good.modelDescriptors[0], id: 'other' }],
      definitions: [{ ...good.definitions[0], model: ['fixture/other'] }]
    }),
    /differs/
  )
  for (const endpoint of [
    'https://example.com/v1/pi/stream',
    'http://127.0.0.1:34567/v1/pi/stream?key=unsafe',
    'http://user@127.0.0.1:34567/v1/pi/stream'
  ])
    await assert.rejects(
      createProductionChildConfig({ ...good, native: { ...good.native, endpoint } })
    )
})

async function publication(t: test.TestContext): Promise<{
  prepared: Awaited<ReturnType<typeof createProductionChildConfig>>
  context: RpcRuntimePreparationContext
  f: Awaited<ReturnType<typeof prepareRemoteSessionStorageFixture>>
}> {
  const f = await prepareRemoteSessionStorageFixture(t)
  const nonce = '12345678-1234-4234-8234-123456789012'
  const identity = {
    nonce,
    phiSessionId: f.scope.phiSessionId,
    projectId: f.scope.projectId,
    projectRoot: f.scope.projectRoot,
    generation: 1
  }
  const prepared = await createProductionChildConfig(
    productionChildOptions({
      identity,
      binding: {
        serverId: f.scope.hostProfileId,
        serverIdentitySha256: f.scope.bindingHash,
        projectId: f.scope.projectId,
        projectRoot: f.scope.projectRoot
      }
    })
  )
  const generationDirectory = join(f.runtimeRoot, 'rpc-sessions', nonce)
  const homePath = join(generationDirectory, 'home')
  const agentDir = join(homePath, '.omp/agent')
  for (const path of [
    join(f.runtimeRoot, 'rpc-sessions'),
    generationDirectory,
    homePath,
    join(homePath, '.omp'),
    agentDir
  ])
    await mkdir(path, { mode: 0o700 })
  const context: RpcRuntimePreparationContext = {
    params: {
      sessionId: f.scope.phiSessionId,
      cwd: f.scope.projectRoot,
      agentDir: '/private-desktop'
    },
    bootstrap: {
      schema: 1,
      nonce,
      sessionId: f.scope.phiSessionId,
      projectId: f.scope.projectId,
      projectRoot: f.scope.projectRoot,
      ompVersion: '18.10.3',
      contentHash: 'd'.repeat(64)
    },
    generation: 1,
    generationDirectory,
    homePath,
    agentDir,
    storage: f.preparation,
    signal: new AbortController().signal
  }
  return { f, prepared, context }
}

test(
  'real registered writer publication verifies private hashes, full compiler manifest and no background artifact',
  { timeout: 30000 },
  async (t) => {
    const { f, prepared, context } = await publication(t)
    await publishProductionChildConfig({ prepared, context, host: f.host })
    const configPath = join(context.generationDirectory, 'child-runtime.json')
    assert.equal((await stat(configPath)).mode & 0o777, 0o600)
    assert.equal((await stat(join(context.agentDir, 'agents'))).mode & 0o777, 0o700)
    const identity = {
      nonce: context.bootstrap.nonce,
      phiSessionId: f.scope.phiSessionId,
      projectId: f.scope.projectId,
      projectRoot: f.scope.projectRoot,
      generation: 1
    }
    assert.deepEqual(
      loadRpcChildRuntimeConfig(join(context.generationDirectory, 'config.json'), identity, {
        required: true
      }),
      prepared.config
    )
    const manifest = JSON.parse(
      await readFile(join(context.agentDir, 'phi-agent-definitions.json'), 'utf8')
    )
    assert.equal(manifest.entries.length, 2)
    assert.equal(
      manifest.entries.filter((entry: { blocking: boolean }) => entry.blocking).length,
      1
    )
    await assert.rejects(
      publishProductionChildConfig({ prepared, context, host: f.host }),
      /Cannot publish/
    )
  }
)

test(
  'publication rejects unregistered storage and a symlinked generation child directory',
  { timeout: 30000 },
  async (t) => {
    const { f, prepared, context } = await publication(t)
    await assert.rejects(
      publishProductionChildConfig({
        prepared,
        context: { ...context, storage: { ...f.preparation } },
        host: f.host
      }),
      /Unknown storage preparation|registered writer/
    )
    await symlink(f.scope.projectRoot, join(context.agentDir, 'agents'))
    await assert.rejects(
      publishProductionChildConfig({ prepared, context, host: f.host }),
      /Cannot publish/
    )
  }
)
