import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { selectRemoteModel } from '../src/main/agent/engine/rpc/model-selection'
import { writeRemoteModelProxyConfig } from '../src/main/agent/engine/rpc/model-proxy-config'
import { loadRpcModelMetadata } from '../src/main/agent/engine/phi-extension/lib/rpc-model-metadata'
import type { RpcBootstrapConfig } from '../src/main/agent/engine/phi-extension/lib/rpc-config'
import { preflightRemoteJournal } from '../src/main/agent/engine/rpc/session-storage/remote-preflight'
import type {
  RemoteSessionReference,
  RemoteSessionStoragePreparation
} from '../src/main/agent/engine/rpc/session-storage/types'
import { acquirePersistentLaunchStorage } from '../src/main/agent/engine/rpc/persistent-launch-storage'
import { shellQuote } from '../src/main/agent/wrappers/remote-ssh-session'
import { startLoopbackModel } from './engine-contract/loopback-model'
import { createModelProxyConfigFixture } from './helpers/modelProxyConfigFixture'
import { deferred } from './helpers/rpc-initialization-wire'
import type { RpcStartupFile } from '../src/main/agent/engine/rpc/startup-transaction'
import {
  createPersistentLauncherFixture,
  scanPersistentLauncherFiles,
  writePersistentLauncherModel
} from './helpers/persistentLauncherFixture'

const safeModel = {
  provider: 'phi-contract',
  id: 'contract-model',
  name: 'Private model',
  reasoning: false,
  input: ['text' as const, 'image' as const],
  contextWindow: null,
  maxTokens: null
}

test('private config writer and metadata reader support default SDK agent layout and reject unsafe managed ancestors', async (t) => {
  const f = await createModelProxyConfigFixture()
  t.after(f.cleanup)
  const home = dirname(f.agentDir)
  const agentDir = join(home, '.omp/agent')
  await mkdir(agentDir, { recursive: true, mode: 0o700 })
  const nonce = dirname(home).split('/').at(-1)!
  const queued: RpcStartupFile[] = []
  const options = {
    session: f.session,
    agentDir,
    sessionId: 'persistent-model-session',
    projectRoot: f.projectRoot,
    gatewayGeneration: 1,
    remotePort: 41000,
    gatewayBearer: 'Z'.repeat(43),
    models: [safeModel],
    startup: {
      addDirectory: () => undefined,
      addFile(file: RpcStartupFile) {
        queued.push(file)
      }
    }
  }
  const published = await writeRemoteModelProxyConfig(options)
  for (const file of queued)
    await writeFile(file.path, file.bytes, { mode: file.mode, flag: file.ifAbsent ? 'wx' : 'w' })
  assert.equal(published.nonce, nonce)
  const config: RpcBootstrapConfig = {
    schema: 1,
    nonce,
    sessionId: options.sessionId,
    projectId: 'project',
    projectRoot: f.projectRoot,
    ompVersion: '18.10.3',
    contentHash: 'a'.repeat(64)
  }
  assert.deepEqual(loadRpcModelMetadata(agentDir, config)?.models, [safeModel])
  for (const path of [home, dirname(agentDir), dirname(home), dirname(dirname(home))]) {
    await chmod(path, 0o755)
    assert.throws(() => loadRpcModelMetadata(agentDir, config), /private owned/)
    await chmod(path, 0o700)
  }
  const metadata = join(agentDir, 'phi-model-metadata.json')
  const alias = join(agentDir, 'hardlink.json')
  await link(metadata, alias)
  assert.throws(() => loadRpcModelMetadata(agentDir, config), /private owned/)
  await rm(alias)
  const old = join(home, '.omp-original')
  await rename(dirname(agentDir), old)
  await symlink(old, dirname(agentDir))
  assert.throws(() => loadRpcModelMetadata(agentDir, config), /canonical/)
})

test('persistent mode binds derived storage and keeps generation secrets ephemeral while its lease belongs to the channel', async (t) => {
  const f = await createPersistentLauncherFixture()
  t.after(f.cleanup)
  const factory = await f.factory({
    prepareSession: async ({ homePath, agentDir }) => {
      assert.equal(agentDir, join(homePath, '.omp/agent'))
    }
  })
  const channel = await factory.open(f.params, new AbortController().signal)
  const [nonce] = await readdir(join(f.runtimeRoot, 'rpc-sessions'))
  const generation = join(f.runtimeRoot, 'rpc-sessions', nonce)
  const home = join(generation, 'home')
  const command = f.session.commands.find((command) => command.includes('exec env -i'))!
  assert.ok(command.includes(`cd -- ${shellQuote(home)}`))
  assert.ok(command.includes(`PI_CODING_AGENT_DIR=${shellQuote(join(home, '.omp/agent'))}`))
  assert.ok(command.includes(`XDG_DATA_HOME=${shellQuote(f.paths.data)}`))
  assert.ok(command.includes(`'--session-dir' ${shellQuote(f.paths.journals)}`))
  assert.ok(!command.includes('--no-session'))
  assert.ok(!command.includes('--resume') && !command.includes('--continue'))
  assert.ok(command.includes('PI_REQ_DEBUG=0'))
  assert.deepEqual(
    JSON.parse(await readFile(join(generation, 'startup-policy.json'), 'utf8')).goal,
    { continuationModes: [] }
  )
  for (const path of [
    generation,
    home,
    join(home, '.omp'),
    join(home, '.omp/agent'),
    join(generation, 'state'),
    join(generation, 'state/omp'),
    join(generation, 'cache/omp'),
    join(generation, 'tmp')
  ])
    assert.equal((await stat(path)).mode & 0o777, 0o700)
  await channel.close()
  assert.deepEqual(await readdir(join(f.runtimeRoot, 'rpc-sessions')), [])
  assert.ok((await stat(f.paths.journals)).isDirectory())
  assert.ok((await stat(f.paths.blobs)).isDirectory())
  assert.throws(() => f.preparations[0].lease.assertActive(), { code: 'LEASE_LOST' })
  assert.equal(f.session.closed, false)
})

test('lease loss closes only its owned channel and releases generation configuration', async (t) => {
  const f = await createPersistentLauncherFixture()
  t.after(f.cleanup)
  const factory = await f.factory()
  const channel = await factory.open(f.params, new AbortController().signal)
  await f.preparations[0].lease.release()
  await Promise.race([
    channel.closed,
    delay(2000).then(() => assert.fail('Lease revocation did not close owned channel'))
  ])
  await channel.close()
  assert.deepEqual(await readdir(join(f.runtimeRoot, 'rpc-sessions')), [])
  assert.equal((await f.session.exec('printf master-alive')).stdout, 'master-alive')
  assert.equal(f.session.closed, false)
})

test('cancelled late storage acquisition is observed and releases its lease without opening an OMP channel', async (t) => {
  const f = await createPersistentLauncherFixture()
  t.after(f.cleanup)
  const storage = await f.acquire({ params: f.params, signal: new AbortController().signal })
  const gate = deferred<RemoteSessionStoragePreparation>()
  const entered = deferred<void>()
  const factory = await f.factory({
    preparePersistentStorage: async () => {
      entered.resolve()
      return gate.promise
    }
  })
  const controller = new AbortController()
  const opening = factory.open(f.params, controller.signal)
  await entered.promise
  const rejected = assert.rejects(opening, { name: 'AbortError' })
  controller.abort()
  await rejected
  gate.resolve(storage)
  for (let i = 0; i < 100 && !storage.lease.signal.aborted; i++) await delay(10)
  assert.equal(storage.lease.signal.aborted, true)
  assert.equal(
    f.session.commands.some((command) => command.includes('exec env -i')),
    false
  )
  assert.equal(f.session.closed, false)
})

test('an unregistered storage-shaped locator cannot become launch authority', async (t) => {
  const f = await createPersistentLauncherFixture()
  t.after(f.cleanup)
  const storage = await f.acquire({ params: f.params, signal: new AbortController().signal })
  const factory = await f.factory({ preparePersistentStorage: async () => ({ ...storage }) })
  await assert.rejects(factory.open(f.params, new AbortController().signal), {
    code: 'INVALID_SCOPE'
  })
  assert.equal(
    f.session.commands.some((command) => command.includes('exec env -i')),
    false
  )
  assert.equal(storage.lease.signal.aborted, true)
})

test(
  'real factory-launched persistent OMP restores journal and image blobs after disposable HOME deletion',
  { timeout: 120000 },
  async (t) => {
    const f = await createPersistentLauncherFixture(true)
    t.after(f.cleanup)
    const provider = await startLoopbackModel()
    t.after(provider.close)
    const bearers: string[] = []
    const factory = await f.factory({
      prepareSession: async ({ agentDir, startup }) => {
        const bearer = `synthetic-launcher-${randomBytes(24).toString('hex')}`
        bearers.push(bearer)
        writePersistentLauncherModel(startup, agentDir, provider.url, bearer)
      }
    })
    const first = await f.connect(factory)
    await first.connection.request({ type: 'new_session' })
    const state = await first.connection.request<{ sessionId: string; sessionFile: string }>({
      type: 'get_state'
    })
    assert.equal(dirname(state.sessionFile), f.paths.journals)
    const reference: RemoteSessionReference = {
      ...f.scope,
      kind: 'remote-omp',
      version: 1,
      ompVersion: '18.10.3',
      durableSessionKey: f.paths.durableSessionKey,
      ompSessionId: state.sessionId,
      journalBasename: basename(state.sessionFile)
    }
    const verifyPrivateStorage = async (generation: number): Promise<void> => {
      // Check the SDK-created file before preflight; no chmod-after-creation repair is allowed.
      assert.equal((await stat(state.sessionFile)).mode & 0o777, 0o600, 'SDK journal creation mode')
      const proof = await preflightRemoteJournal(f.preparations[generation], reference)
      assert.equal(proof.journalPath, state.sessionFile)
      assert.equal(proof.ompSessionId, state.sessionId)
      const durableFiles = await scanPersistentLauncherFiles(f.paths.directory)
      for (const file of durableFiles)
        assert.equal(
          (await stat(file.path)).mode & 0o777,
          0o600,
          `Durable SDK file mode: ${file.path}`
        )
    }
    assert.ok(
      f.session.commands.some(
        (command) => command.startsWith('umask 022\n') && command.includes('exec env -i')
      )
    )
    await verifyPrivateStorage(0)
    assert.equal(provider.requests.length, 0)
    const png = (await readFile(join(process.cwd(), 'resources/icon.png'))).toString('base64')
    provider.enqueue({ text: 'Retained launcher history' })
    const result = await first.connection.prompt('Remember before persistent restart', {
      images: [{ type: 'image', mimeType: 'image/png', data: png }]
    })
    assert.equal(result.status, 'completed')
    await verifyPrivateStorage(0)
    const normalized = /data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/.exec(
      JSON.stringify(provider.requests[0])
    )?.[1]
    assert.ok(normalized)
    const files = await scanPersistentLauncherFiles(f.paths.directory)
    assert.ok(
      files.some(
        (file) =>
          file.path.startsWith(f.paths.blobs + '/') &&
          file.bytes.equals(Buffer.from(normalized, 'base64'))
      )
    )
    await first.connection.request({
      type: 'goal',
      op: 'create',
      objective: 'Saved goal must await explicit user request',
      token_budget: 10000
    })
    const activeJournal = await readFile(state.sessionFile)
    await first.connection.close()
    await assert.rejects(readFile(join(first.home, '.omp/agent/models.yml')), { code: 'ENOENT' })
    assert.ok((await readFile(state.sessionFile)).length > 0)
    // Restore the SDK-created active-goal checkpoint to test startup continuation policy.
    await writeFile(state.sessionFile, activeJournal, { mode: 0o600 })
    const second = await f.connect(factory)
    assert.notEqual(first.home, second.home)
    assert.notEqual(bearers[0], bearers[1])
    const frames = second.frames
    await second.connection.request({ type: 'switch_session', sessionPath: state.sessionFile })
    const restored = await second.connection.request<{
      sessionId: string
      sessionFile: string
      goal: { enabled: boolean }
    }>({ type: 'get_state' })
    assert.equal(restored.sessionId, state.sessionId)
    assert.equal(restored.sessionFile, state.sessionFile)
    assert.equal(restored.goal.enabled, true)
    await verifyPrivateStorage(1)
    assert.equal(frames.includes('agent_start'), false)
    assert.equal(provider.requests.length, 1)
    provider.enqueue({ text: 'New explicit turn' })
    await second.connection.prompt('Continue after persistent restart')
    await verifyPrivateStorage(1)
    assert.ok(JSON.stringify(provider.requests[1]).includes('Remember before persistent restart'))
    assert.ok(JSON.stringify(provider.requests[1]).includes('Retained launcher history'))
    assert.ok(JSON.stringify(provider.requests[1]).includes(normalized))
    await second.connection.close()
    const durable = await scanPersistentLauncherFiles(f.paths.directory)
    for (const bearer of bearers)
      assert.equal(
        durable.some((file) => file.bytes.includes(Buffer.from(bearer))),
        false
      )
    assert.deepEqual(await readdir(join(f.runtimeRoot, 'rpc-sessions')), [])
    assert.equal(f.session.closed, false)
  }
)

test('registered storage for another Phi session, project or runtime is released before launch', async (t) => {
  const f = await createPersistentLauncherFixture()
  t.after(f.cleanup)
  for (const mismatch of ['Phi session', 'project', 'runtime'] as const) {
    const storage = await f.acquire({ params: f.params, signal: new AbortController().signal })
    await assert.rejects(
      acquirePersistentLaunchStorage(
        async () => storage,
        {
          params:
            mismatch === 'Phi session'
              ? { ...f.params, sessionId: 'another-phi-session' }
              : f.params,
          signal: new AbortController().signal
        },
        {
          host: f.host,
          projectId: mismatch === 'project' ? 'another-project' : f.scope.projectId,
          runtimeRoot: mismatch === 'runtime' ? f.root : f.runtimeRoot
        }
      ),
      { code: 'IDENTITY_MISMATCH' }
    )
    assert.equal(storage.lease.signal.aborted, true)
  }
  assert.equal(
    f.session.commands.some((command) => command.includes('exec env -i')),
    false
  )
})

test('proxy preparation failure releases acquired storage without creating remote startup paths', async (t) => {
  const f = await createPersistentLauncherFixture()
  t.after(f.cleanup)
  const factory = await f.factory({
    prepareSession: async () => {
      throw new Error('Synthetic proxy preparation failure')
    }
  })
  await assert.rejects(
    factory.open(f.params, new AbortController().signal),
    /Synthetic proxy preparation failure/
  )
  assert.equal(f.preparations[0].lease.signal.aborted, true)
  await assert.rejects(readdir(join(f.runtimeRoot, 'rpc-sessions')), { code: 'ENOENT' })
  await assert.rejects(stat(f.paths.journals), { code: 'ENOENT' })
  assert.equal(
    f.session.commands.some((command) => command.includes('exec env -i')),
    false
  )
  assert.equal(f.session.closed, false)
})

test('lease revocation during delayed OMP channel acquisition retires the late owned channel', async (t) => {
  const f = await createPersistentLauncherFixture()
  t.after(f.cleanup)
  const factory = await f.factory()
  const original = f.session.openStdio!
  const entered = deferred<void>()
  const gate = deferred<void>()
  const closedLate = deferred<void>()
  f.session.openStdio = async (command) => {
    if (!command.includes('exec env -i')) return original(command)
    entered.resolve()
    await gate.promise
    const channel = await original(command)
    return {
      ...channel,
      close: async () => {
        await channel.close()
        closedLate.resolve()
      }
    }
  }
  const opening = factory.open(f.params, new AbortController().signal)
  void opening.catch(() => undefined)
  await entered.promise
  const rejected = assert.rejects(opening, { code: 'LEASE_LOST' })
  await f.preparations[0].lease.release()
  await rejected
  assert.deepEqual(await readdir(join(f.runtimeRoot, 'rpc-sessions')), [])
  gate.resolve()
  await Promise.race([
    closedLate.promise,
    delay(2000).then(() => assert.fail('Late channel was not retired'))
  ])
  assert.ok((await stat(f.paths.data)).isDirectory())
  assert.equal(f.session.closed, false)
})

test(
  'real persistent factory attests the new private metadata layout and restores exact null limits without provider execution',
  { timeout: 60000 },
  async (t) => {
    const f = await createPersistentLauncherFixture(true)
    t.after(f.cleanup)
    const writer = await createModelProxyConfigFixture()
    t.after(writer.cleanup)
    const factory = await f.factory({
      prepareSession: async ({ agentDir, startup }) => {
        await writeRemoteModelProxyConfig({
          session: writer.session,
          agentDir,
          sessionId: f.params.sessionId,
          projectRoot: f.scope.projectRoot,
          gatewayGeneration: 1,
          remotePort: 41000,
          gatewayBearer: 'N'.repeat(43),
          models: [safeModel],
          startup
        })
        startup.addFile({
          item: 'fixture-agent-config',
          path: join(agentDir, 'config.yml'),
          bytes: Buffer.from(
            JSON.stringify({
              defaultProvider: safeModel.provider,
              defaultModel: safeModel.id,
              compaction: { enabled: false },
              extensions: [],
              skills: [],
              memory: { enabled: false }
            })
          ),
          mode: 0o600,
          ifAbsent: true
        })
      }
    })
    const first = await f.connect(factory)
    const config = JSON.parse(
      await readFile(join(dirname(first.home), 'config.json'), 'utf8')
    ) as RpcBootstrapConfig
    const metadata = loadRpcModelMetadata(join(first.home, '.omp/agent'), config)
    assert.ok(metadata)
    await selectRemoteModel(first.connection, metadata, safeModel, new AbortController().signal)
    const state = await first.connection.request<{
      model: { contextWindow: number | null; maxTokens: number | null }
    }>({ type: 'get_state' })
    assert.equal(state.model.contextWindow, null)
    assert.equal(state.model.maxTokens, null)
    assert.equal(first.frames.includes('agent_start'), false)
    assert.doesNotMatch(first.stderr(), /NNNNNNNNNNNN/)
    await first.connection.close()
  }
)

test(
  'actual SDK non-default agent directory ignores durable XDG blob storage, guarding the required default-layout choice',
  { timeout: 60000 },
  async (t) => {
    const f = await createPersistentLauncherFixture(true)
    t.after(f.cleanup)
    const provider = await startLoopbackModel()
    t.after(provider.close)
    let defaultAgent = ''
    let legacyAgent = ''
    const factory = await f.factory({
      prepareSession: async ({ homePath, agentDir, startup }) => {
        defaultAgent = agentDir
        legacyAgent = join(homePath, 'agent')
        startup.addDirectory({ path: legacyAgent, ifAbsent: true })
        writePersistentLauncherModel(startup, agentDir, provider.url, 'synthetic-default-control')
        writePersistentLauncherModel(startup, legacyAgent, provider.url, 'synthetic-legacy-control')
      }
    })
    // Negative control changes only the emitted CLI agent-dir environment. The SDK is untouched.
    const open = f.session.openStdio!
    f.session.openStdio = (command) =>
      open(
        command.includes('exec env -i')
          ? command.replace(
              `PI_CODING_AGENT_DIR=${shellQuote(defaultAgent)}`,
              `PI_CODING_AGENT_DIR=${shellQuote(legacyAgent)}`
            )
          : command
      )
    const channel = await f.connect(factory)
    await channel.connection.request({ type: 'new_session' })
    provider.enqueue({ text: 'Non-default XDG control' })
    const png = (await readFile(join(process.cwd(), 'resources/icon.png'))).toString('base64')
    await channel.connection.prompt('Persist the control image', {
      images: [{ type: 'image', mimeType: 'image/png', data: png }]
    })
    const normalized = /data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/.exec(
      JSON.stringify(provider.requests[0])
    )?.[1]
    assert.ok(normalized)
    const image = Buffer.from(normalized, 'base64')
    assert.equal(
      (await scanPersistentLauncherFiles(f.paths.blobs)).some((file) => file.bytes.equals(image)),
      false
    )
    assert.ok(
      (await scanPersistentLauncherFiles(join(legacyAgent, 'blobs'))).some((file) =>
        file.bytes.equals(image)
      )
    )
    await channel.connection.close()
  }
)
