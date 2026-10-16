import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, link, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  deriveProductionChildBinding,
  createProductionChildConfig,
  publishProductionChildConfig,
  assertPreparedProductionChildConfig,
  type CreateProductionChildConfigOptions
} from '../src/main/agent/engine/rpc/subagents/production-child-config'
import {
  loadRpcChildRuntimeConfig,
  rpcChildDispatchConflictReason
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-config'
import type { RemoteWorkspaceHostBinding } from '../src/main/agent/remote-workspace-boundary'
import type { RpcRuntimePreparationContext } from '../src/main/agent/engine/rpc/ssh-stdio-factory'
import { prepareRemoteSessionStorageFixture } from './helpers/remoteSessionStorageFixture'
import { productionChildOptions } from './helpers/productionChildNodeFixture'
import { definition } from './helpers/rpcAgentDefinitionFixture'
import { shellQuote } from '../src/main/agent/wrappers/remote-ssh-session'

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

test('project alias publication stays in the attested file inventory and session deferral blocks only named profiles', async () => {
  const base = productionChildOptions()
  const options = productionChildOptions({
    definitions: [
      ...base.definitions,
      definition({
        ...base.definitions[0],
        name: 'Reviewer',
        systemPrompt: 'SECOND_PRIVATE_CHILD'
      })
    ]
  })
  const alias = 'Writer-phi'
  const prepared = await createProductionChildConfig({
    ...options,
    aliases: { Writer: alias },
    blockedAgents: {
      [alias]: {
        filePath: '/srv/project/.omp/agents/shadow.md',
        contentHash: 'd'.repeat(64)
      }
    }
  })
  const aliased = prepared.config.profiles.find(
    (profile) => profile.definition.nativeName === alias
  )!
  const other = prepared.config.profiles.find((profile) => profile.definition.nativeName !== alias)!
  assert.equal(aliased.definition.phiName, 'Writer')
  assert.equal(aliased.definition.displayName, alias)
  assert.ok(prepared.config.files.some((file) => file.path === `agents/${alias}.md`))
  assert.deepEqual(prepared.config.blockedAgents, [
    {
      nativeName: alias,
      filePath: '/srv/project/.omp/agents/shadow.md',
      contentHash: 'd'.repeat(64)
    }
  ])
  assert.match(
    rpcChildDispatchConflictReason(
      { agent: alias, task: 'blocked', solutionSpace: 'test' },
      prepared.config
    )!,
    /shadow\.md/u
  )
  assert.equal(
    rpcChildDispatchConflictReason(
      { agent: other.definition.nativeName, task: 'allowed', solutionSpace: 'test' },
      prepared.config
    ),
    undefined
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

async function publication(
  t: test.TestContext,
  overrides: Partial<CreateProductionChildConfigOptions> = {}
): Promise<{
  prepared: Awaited<ReturnType<typeof createProductionChildConfig>>
  context: RpcRuntimePreparationContext
  f: Awaited<ReturnType<typeof prepareRemoteSessionStorageFixture>>
}> {
  const f = await prepareRemoteSessionStorageFixture(t)
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
    signal: t.signal
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
  'child publication keeps metadata round trips bounded across four files and full profile selection',
  { timeout: 30000 },
  async (t) => {
    for (const agents of [1, 16]) {
      const { f, prepared, context } = await publication(t, {
        allowBackground: true,
        definitions: Array.from({ length: agents }, (_, index) =>
          definition({ name: 'Inspector' + index, tools: ['read'], skills: [] })
        )
      })
      let runs = 0
      const run = f.host.exec.run.bind(f.host.exec)
      f.host.exec.run = (command, options) => {
        runs++
        assert.equal(options.timeoutMs, 30000)
        assert.equal(options.maxOutputBytes, 1024)
        return run(command, options)
      }
      await publishProductionChildConfig({ prepared, context, host: f.host })
      t.diagnostic(`${prepared.config.files.length + 1} files: ${runs} metadata round trips`)
      assert.ok(runs <= 3, 'per-file metadata jobs must not consume the RPC startup budget')
      assert.equal(prepared.config.profiles.length, agents * 2)
      assert.equal(
        (await stat(join(context.generationDirectory, 'child-runtime.json'))).mode & 0o777,
        0o600
      )
    }
  }
)

test(
  'child publication verifies all artifacts before exposing the sidecar',
  { timeout: 30000 },
  async (t) => {
    const { f, prepared, context } = await publication(t, { allowBackground: true })
    const upload = f.host.transfer!.uploadFile.bind(f.host.transfer)
    const destinations: string[] = []
    let damaged: string | undefined
    let staging: string | undefined
    f.host.transfer!.uploadFile = async (source, destination, options) => {
      staging = dirname(source)
      destinations.push(destination)
      await upload(source, destination, options)
      if (destinations.length === 2) {
        damaged = destinations[0]
        await writeFile(damaged, 'TAMPERED_AFTER_EARLIER_UPLOAD')
      }
    }
    await assert.rejects(
      publishProductionChildConfig({ prepared, context, host: f.host }),
      /Cannot publish/
    )
    assert.ok(damaged, 'the corruption must occur after the real second upload')
    assert.ok(!destinations.some((path) => path.endsWith('/child-runtime.json')))
    await assert.rejects(readFile(join(context.generationDirectory, 'child-runtime.json')), {
      code: 'ENOENT'
    })
    assert.ok(staging)
    await assert.rejects(stat(staging), { code: 'ENOENT' })
  }
)

test(
  'child publication cannot overwrite a sidecar appearing after the initial preflight',
  { timeout: 30000 },
  async (t) => {
    const { f, prepared, context } = await publication(t, { allowBackground: true })
    const sidecar = join(context.generationDirectory, 'child-runtime.json')
    const upload = f.host.transfer!.uploadFile.bind(f.host.transfer)
    let calls = 0,
      injected = false
    f.host.transfer!.uploadFile = async (...args) => {
      calls++
      await upload(...args)
      if (calls === 2) {
        await writeFile(sidecar, 'EXISTING_SIDECAR', { mode: 0o600, flag: 'wx' })
        injected = true
      }
    }
    await assert.rejects(
      publishProductionChildConfig({
        prepared,
        context,
        host: f.host,
        uploadOptions: { reuseVerifiedDestination: true }
      }),
      /Cannot publish/
    )
    assert.ok(injected, 'the real preflight must finish before the sidecar appears')
    assert.equal(await readFile(sidecar, 'utf8'), 'EXISTING_SIDECAR')
    assert.equal(calls, prepared.config.files.length)
  }
)

test(
  'child publication rejects changed artifact kind, links or digest before sidecar publication',
  { timeout: 30000 },
  async (t) => {
    for (const fault of ['symlink', 'hardlink', 'digest'])
      await t.test(fault, async (t) => {
        const { f, prepared, context } = await publication(t, { allowBackground: true })
        const upload = f.host.transfer!.uploadFile.bind(f.host.transfer)
        const destinations: string[] = []
        let injected = false
        f.host.transfer!.uploadFile = async (source, destination, options) => {
          assert.equal(
            options?.expectedSha256,
            createHash('sha256')
              .update(await readFile(source))
              .digest('hex')
          )
          destinations.push(destination)
          await upload(source, destination, options)
          if (destinations.length !== 1) return
          if (fault === 'symlink') {
            await rm(destination)
            await symlink(f.scope.projectRoot, destination)
          } else if (fault === 'hardlink') await link(destination, join(f.root, 'extra-link'))
          else await writeFile(destination, 'TAMPERED_ARTIFACT')
          injected = true
        }
        await assert.rejects(
          publishProductionChildConfig({ prepared, context, host: f.host }),
          /Cannot publish/
        )
        assert.ok(injected, 'the real upload must finish before the fault is introduced')
        assert.ok(!destinations.some((path) => path.endsWith('/child-runtime.json')))
      })
  }
)

test(
  'child publication stops at the original cancellation or lease boundary without a later upload',
  { timeout: 30000 },
  async (t) => {
    for (const boundary of ['before', 'upload', 'verified', 'lease'])
      await t.test(boundary, async (t) => {
        const { f, prepared, context } = await publication(t, { allowBackground: true })
        const controller = new AbortController()
        let reason: unknown = new Error('OWNED_PUBLICATION_CANCELLED')
        let calls = 0,
          verified = false
        const upload = f.host.transfer!.uploadFile.bind(f.host.transfer)
        f.host.transfer!.uploadFile = async (...args) => {
          calls++
          await upload(...args)
          if (calls === 1 && boundary === 'upload') controller.abort(reason)
          if (calls === 1 && boundary === 'lease') {
            await f.preparation.lease.release()
            reason = f.preparation.lease.signal.reason
          }
        }
        const lastArtifact = join(context.agentDir, prepared.config.files.at(-1)!.path)
        const run = f.host.exec.run.bind(f.host.exec)
        f.host.exec.run = async (command, options) => {
          const result = await run(command, options)
          if (
            boundary === 'verified' &&
            command[2].includes(`private_file ${shellQuote(lastArtifact)}`)
          ) {
            verified = true
            controller.abort(reason)
          }
          return result
        }
        if (boundary === 'before') controller.abort(reason)
        await assert.rejects(
          publishProductionChildConfig({
            prepared,
            context: { ...context, signal: AbortSignal.any([context.signal, controller.signal]) },
            host: f.host
          }),
          (error) => error === reason
        )
        assert.equal(
          calls,
          boundary === 'before' ? 0 : boundary === 'verified' ? prepared.config.files.length : 1
        )
        assert.equal(verified, boundary === 'verified')
        await assert.rejects(readFile(join(context.generationDirectory, 'child-runtime.json')), {
          code: 'ENOENT'
        })
      })
  }
)

test(
  'child publication retains metadata result guards before the ready sidecar',
  { timeout: 30000 },
  async (t) => {
    for (const fault of ['code', 'truncated', 'terminated'])
      await t.test(fault, async (t) => {
        const { f, prepared, context } = await publication(t)
        let reached = false
        const run = f.host.exec.run.bind(f.host.exec)
        f.host.exec.run = async (command, options) => {
          const result = await run(command, options)
          if (!command[2].includes("fail 'Private child artifact was corrupted'")) return result
          reached = true
          return {
            ...result,
            ...(fault === 'code'
              ? { code: 1 }
              : fault === 'truncated'
                ? { truncated: true }
                : { terminationReason: 'cancelled' as const })
          }
        }
        await assert.rejects(
          publishProductionChildConfig({ prepared, context, host: f.host }),
          /Cannot publish/
        )
        assert.ok(reached, 'the real resource verification must complete before the result fault')
        await assert.rejects(readFile(join(context.generationDirectory, 'child-runtime.json')), {
          code: 'ENOENT'
        })
      })
  }
)

test(
  'child publication chunks large resource inventories within the original command and output budgets',
  { timeout: 30000 },
  async (t) => {
    const skills = Array.from({ length: 128 }, (_, index) => ({
      name: 'method-' + index,
      description: 'Selected method',
      markdown: '# Unique method ' + index
    }))
    const { f, prepared, context } = await publication(t, {
      definitions: [
        definition({ name: 'Reader', tools: ['read'], skills: skills.map((skill) => skill.name) })
      ],
      availableTools: [{ name: 'read', site: 'native' }],
      availableSkills: skills.map((skill) => skill.name),
      resources: { hostTools: [], skills }
    })
    let calls = 0
    const run = f.host.exec.run.bind(f.host.exec)
    f.host.exec.run = (command, options) => {
      calls++
      assert.ok(Buffer.byteLength(command[2]) <= 32 * 1024)
      assert.equal(options.timeoutMs, 30000)
      assert.equal(options.maxOutputBytes, 1024)
      return run(command, options)
    }
    const destinations: string[] = []
    f.host.transfer!.uploadFile = async (source, destination, options) => {
      assert.equal(
        options?.expectedSha256,
        createHash('sha256')
          .update(await readFile(source))
          .digest('hex')
      )
      destinations.push(destination)
      await copyFile(source, destination)
    }
    await publishProductionChildConfig({ prepared, context, host: f.host })
    assert.ok(calls > 3, 'the valid inventory must actually exercise command chunking')
    assert.equal(destinations.length, prepared.config.files.length + 1)
    assert.equal(destinations.at(-1), join(context.generationDirectory, 'child-runtime.json'))
    for (const file of prepared.config.files)
      assert.equal(
        createHash('sha256')
          .update(await readFile(join(context.agentDir, file.path)))
          .digest('hex'),
        file.sha256
      )
    t.diagnostic(`${destinations.length} files: ${calls} bounded metadata round trips`)
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
