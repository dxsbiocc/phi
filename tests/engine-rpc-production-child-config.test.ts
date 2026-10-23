import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  deriveProductionChildBinding,
  createProductionChildConfig,
  publishProductionChildConfig,
  assertPreparedProductionChildConfig,
  type CreateProductionChildConfigOptions
} from '../src/main/agent/engine/rpc/subagents/production-child-config'
import type { RemoteWorkspaceHostBinding } from '../src/main/agent/remote-workspace-boundary'
import type { RpcRuntimePreparationContext } from '../src/main/agent/engine/rpc/ssh-stdio-factory'
import { validateRpcChildRuntimeConfig } from '../src/main/agent/engine/phi-extension/lib/rpc-child-config'
import { RpcStartupTransactionBuilder } from '../src/main/agent/engine/rpc/startup-transaction'
import { registerStorageHost } from '../src/main/agent/engine/rpc/session-storage/remote-preflight'
import type { RemoteSessionStoragePreparation } from '../src/main/agent/engine/rpc/session-storage/types'
import { createRemoteSessionStorageFixture } from './helpers/remoteSessionStorageFixture'
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

test('Cursor child profiles fail before a pi-native child route can be published', async () => {
  const good = productionChildOptions()
  const cursor = { provider: 'cursor', id: 'cursor-grok-4.6-fast' }
  await assert.rejects(
    createProductionChildConfig({
      ...good,
      parentModel: cursor,
      modelDescriptors: [{ ...good.modelDescriptors[0], ...cursor }],
      native: { ...good.native, models: [cursor] }
    }),
    /Cursor (?:parent|child) model requires a scoped native route/
  )
})

test('Cursor child profiles bind only the owned scoped native tunnel', async () => {
  const good = productionChildOptions()
  const cursor = { provider: 'cursor', id: 'cursor-grok-4.6-fast' }
  const options = {
    ...good,
    parentModel: cursor,
    modelDescriptors: [{ ...good.modelDescriptors[0], ...cursor }],
    native: {
      ...good.native,
      models: [cursor],
      cursorEndpoint: 'http://127.0.0.1:34568'
    }
  }
  const prepared = await createProductionChildConfig(options)
  assert.deepEqual(prepared.config.profiles[0].route, {
    api: 'cursor-agent',
    baseUrl: 'http://127.0.0.1:34568',
    transport: 'sse'
  })
  assert.throws(
    () =>
      validateRpcChildRuntimeConfig(
        {
          ...prepared.config,
          profiles: [
            {
              ...prepared.config.profiles[0],
              route: {
                api: 'openai-completions',
                baseUrl: 'http://127.0.0.1:34568',
                transport: 'pi-native'
              }
            }
          ]
        },
        options.identity
      ),
    /route differs/
  )
  await assert.rejects(
    createProductionChildConfig({
      ...options,
      native: { ...options.native, cursorEndpoint: 'http://user@127.0.0.1:34568' }
    }),
    /route/
  )
})

async function publication(
  t: test.TestContext,
  overrides: Partial<CreateProductionChildConfigOptions> = {}
): Promise<{
  prepared: Awaited<ReturnType<typeof createProductionChildConfig>>
  context: RpcRuntimePreparationContext
  startup: RpcStartupTransactionBuilder
  f: Awaited<ReturnType<typeof registeredStorageFixture>>
}> {
  const f = await registeredStorageFixture(t)
  const upload = f.host.transfer!.uploadFile.bind(f.host.transfer)
  f.host.transfer!.uploadFile = (source, destination, options) =>
    upload(source, destination, {
      ...options,
      agentDir: join(f.root, 'local-state'),
      hostKey: f.root
    })
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
      ...overrides,
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
  const startup = new RpcStartupTransactionBuilder({
    runtimeRoot: f.runtimeRoot,
    projectRoot: f.scope.projectRoot,
    markers: []
  })
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
    startup,
    signal: t.signal
  }
  return { f, prepared, context, startup }
}

async function registeredStorageFixture(t: test.TestContext): Promise<
  Awaited<ReturnType<typeof createRemoteSessionStorageFixture>> & {
    preparation: RemoteSessionStoragePreparation
  }
> {
  const fixture = await createRemoteSessionStorageFixture()
  const controller = new AbortController()
  let released = false
  const lease = Object.freeze({
    signal: controller.signal,
    lost: new Promise<never>(() => undefined),
    assertActive() {
      controller.signal.throwIfAborted()
      if (released) throw new Error('Session writer lease was released')
    },
    async release() {
      if (released) return
      released = true
      controller.abort(new Error('Session writer lease was released'))
    }
  })
  const preparation = Object.freeze({ scope: fixture.scope, paths: fixture.paths, lease })
  registerStorageHost(preparation, fixture.host)
  t.after(async () => {
    await lease.release()
    await fixture.cleanup()
  })
  return { ...fixture, preparation }
}

test(
  'registered child publication enqueues exact private artifacts with the sidecar last',
  { timeout: 30000 },
  async (t) => {
    const { f, prepared, context, startup } = await publication(t, { allowBackground: true })
    let runs = 0,
      uploads = 0
    const run = f.host.exec.run.bind(f.host.exec)
    f.host.exec.run = (...args) => {
      runs++
      return run(...args)
    }
    const upload = f.host.transfer!.uploadFile.bind(f.host.transfer)
    f.host.transfer!.uploadFile = (...args) => {
      uploads++
      return upload(...args)
    }
    await publishProductionChildConfig({ prepared, context, host: f.host })
    const transaction = startup.build()

    assert.equal(runs, 0)
    assert.equal(uploads, 0)
    assert.deepEqual(transaction.directories[0], {
      path: join(context.agentDir, 'agents'),
      ifAbsent: true
    })
    if (prepared.config.files.some((file) => file.path.startsWith('skills/')))
      assert.deepEqual(transaction.directories[1], {
        path: join(context.agentDir, 'skills'),
        ifAbsent: true
      })
    assert.deepEqual(
      transaction.files.slice(0, -1).map(({ path, mode, ifAbsent }) => ({ path, mode, ifAbsent })),
      prepared.config.files.map((file) => ({
        path: join(context.agentDir, file.path),
        mode: 0o600,
        ifAbsent: true
      }))
    )
    const sidecar = transaction.files.at(-1)!
    assert.equal(sidecar.item, 'child-runtime')
    assert.equal(sidecar.path, join(context.generationDirectory, 'child-runtime.json'))
    assert.equal(sidecar.mode, 0o600)
    assert.equal(sidecar.ifAbsent, true)
    assert.deepEqual(JSON.parse(sidecar.bytes.toString('utf8')), prepared.config)
    const manifestFile = transaction.files.find((file) =>
      file.path.endsWith('/phi-agent-definitions.json')
    )!
    const manifest = JSON.parse(manifestFile.bytes.toString('utf8'))
    assert.equal(manifest.entries.length, 2)
    assert.equal(
      manifest.entries.filter((entry: { blocking: boolean }) => entry.blocking).length,
      1
    )
  }
)

test(
  'child publication queues large resource inventories without any per-file remote round trip',
  { timeout: 30000 },
  async (t) => {
    const skills = Array.from({ length: 128 }, (_, index) => ({
      name: 'method-' + index,
      description: 'Selected method',
      markdown: '# Unique method ' + index
    }))
    const { f, prepared, context, startup } = await publication(t, {
      definitions: [
        definition({ name: 'Reader', tools: ['read'], skills: skills.map((skill) => skill.name) })
      ],
      availableTools: [{ name: 'read', site: 'native' }],
      availableSkills: skills.map((skill) => skill.name),
      resources: { hostTools: [], skills }
    })
    let runs = 0,
      uploads = 0
    const run = f.host.exec.run.bind(f.host.exec)
    f.host.exec.run = (...args) => {
      runs++
      return run(...args)
    }
    const upload = f.host.transfer!.uploadFile.bind(f.host.transfer)
    f.host.transfer!.uploadFile = (...args) => {
      uploads++
      return upload(...args)
    }
    await publishProductionChildConfig({ prepared, context, host: f.host })
    const files = startup.build().files
    assert.equal(runs, 0)
    assert.equal(uploads, 0)
    assert.equal(files.length, prepared.config.files.length + 1)
    assert.equal(files.at(-1)!.path, join(context.generationDirectory, 'child-runtime.json'))
    for (const file of prepared.config.files) {
      const queued = files.find(
        (candidate) => candidate.path === join(context.agentDir, file.path)
      )!
      assert.equal(createHash('sha256').update(queued.bytes).digest('hex'), file.sha256)
    }
    t.diagnostic(`${files.length} files queued for the single startup transaction`)
  }
)

test(
  'publication rejects missing startup ownership, unregistered storage and cancelled leases',
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
    await assert.rejects(
      publishProductionChildConfig({
        prepared,
        context: { ...context, startup: undefined },
        host: f.host
      }),
      /registered writer/
    )
    const reason = new Error('OWNED_PUBLICATION_CANCELLED')
    const controller = new AbortController()
    controller.abort(reason)
    await assert.rejects(
      publishProductionChildConfig({
        prepared,
        context: { ...context, signal: controller.signal },
        host: f.host
      }),
      (error) => error === reason
    )
    await f.preparation.lease.release()
    await assert.rejects(publishProductionChildConfig({ prepared, context, host: f.host }))
  }
)
