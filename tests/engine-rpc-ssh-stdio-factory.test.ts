import assert from 'node:assert/strict'
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createPhiExtensionBundle } from '../src/main/agent/engine/rpc/extension-deployment'
import {
  prepareSshRpcSessionTransport,
  type SshRpcSessionTransport
} from '../src/main/agent/engine/rpc/ssh-stdio-factory'
import {
  RpcSessionBackend,
  type RpcSessionCreateParams
} from '../src/main/agent/engine/rpc/rpc-session-backend'
import { shellQuote } from '../src/main/agent/wrappers/remote-ssh-session'
import { createPhiExtensionDeploymentFixture } from './helpers/phiExtensionDeploymentFixture'
import { createLocalShellSession } from './helpers/localShellSession'
import { attestBootstrap } from '../src/main/agent/engine/rpc/bootstrap-attestation'
import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import type { RpcBootstrapConfig } from '../src/main/agent/engine/phi-extension/lib/rpc-config'
import { startLoopbackModel } from './engine-contract/loopback-model'

function runtimePayload(body: string): string {
  return `#!/bin/sh\nif [ "$1" = --version ]; then printf 'omp/18.10.3\\n'; exit 0; fi\n${body}\n`
}

async function fixtureWithFactory(
  payload = runtimePayload('cat'),
  projectContainsRuntime = false
): Promise<
  Awaited<ReturnType<typeof createPhiExtensionDeploymentFixture>> & {
    session: ReturnType<typeof createLocalShellSession>
    cwd: string
    params: RpcSessionCreateParams
    factory: SshRpcSessionTransport
  }
> {
  const fixture = await createPhiExtensionDeploymentFixture(payload)
  const cwd = projectContainsRuntime
    ? fixture.root
    : join(fixture.root, "project user's $(touch MUST_NOT_EXIST)")
  if (!projectContainsRuntime) await mkdir(cwd)
  const params = { sessionId: 'session-1', cwd, agentDir: 'desktop-agent-dir-must-not-be-copied' }
  // WorkspaceHost owns short command connections separately from the existing
  // persistent RPC connection supplied to this factory.
  const session = createLocalShellSession(fixture.runtimeRoot)
  const factory = await prepareSshRpcSessionTransport({
    session,
    runtime: fixture.options,
    bundle: fixture.bundle,
    projectId: 'project-1'
  })
  return {
    ...fixture,
    session,
    cwd,
    params,
    factory,
    cleanup: async () => {
      await session.close()
      await fixture.cleanup()
    }
  }
}

test('factory consumes the existing stdio channel, quotes paths and creates a private credential-free generation', async (t) => {
  const fixture = await fixtureWithFactory()
  t.after(fixture.cleanup)
  const controller = new AbortController()
  const channel = await fixture.factory.open(fixture.params, controller.signal)
  const sessionBase = join(fixture.runtimeRoot, 'rpc-sessions')
  const [generation] = await readdir(sessionBase)
  const privateRoot = join(sessionBase, generation)
  const configPath = join(privateRoot, 'config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(config.sessionId, fixture.params.sessionId)
  assert.equal(config.projectId, 'project-1')
  assert.equal(config.projectRoot, fixture.cwd)
  assert.equal(config.contentHash, fixture.bundle.contentHash)
  assert.equal(config.nonce, generation)
  assert.equal((await stat(configPath)).mode & 0o777, 0o600)
  for (const path of [
    sessionBase,
    privateRoot,
    join(privateRoot, 'home'),
    join(privateRoot, 'home/agent')
  ])
    assert.equal((await stat(path)).mode & 0o777, 0o700)
  assert.deepEqual(await readdir(join(privateRoot, 'home/agent')), [])
  const command = fixture.session.commands.find((value) => value.includes(' env -i PATH='))!
  assert.ok(command.includes(`cd -- ${shellQuote(join(privateRoot, 'home'))}`))
  assert.ok(command.includes(`'--cwd' ${shellQuote(fixture.cwd)}`))
  assert.ok(command.includes(`PHI_RPC_CONFIG=${shellQuote(configPath)}`))
  assert.ok(command.includes("'--no-extensions' '--trusted-extension'"))
  assert.ok(command.includes("'--trusted-extension'"))
  assert.ok(command.includes(`'--config' ${shellQuote(join(privateRoot, 'startup-policy.json'))}`))
  assert.ok(command.includes("'--no-lsp'"))
  assert.ok(command.includes("'--no-skills' '--no-rules' '--no-lsp'"))
  assert.ok(!command.includes('--no-ui'))
  assert.ok(!command.includes(fixture.params.agentDir))
  assert.deepEqual(JSON.parse(await readFile(join(privateRoot, 'startup-policy.json'), 'utf8')), {
    disabledProviders: ['native', 'claude', 'codex', 'omp-plugins', 'claude-plugins'],
    mcp: { enableProjectConfig: false },
    extensions: [],
    skills: [],
    lsp: { enabled: false },
    memory: { enabled: false }
  })
  await assert.rejects(access(join(fixture.runtimeRoot, 'MUST_NOT_EXIST')), { code: 'ENOENT' })
  await channel.close()
  assert.deepEqual(await readdir(sessionBase), [])
  assert.equal(fixture.session.closed, false)
  assert.equal((await fixture.session.exec('printf still-connected')).stdout, 'still-connected')
})

test('project plugin tools are refused before the OMP stdio process starts', async (t) => {
  const fixture = await fixtureWithFactory()
  t.after(fixture.cleanup)
  const plugins = join(fixture.cwd, '.omp/plugins')
  const plugin = join(plugins, 'node_modules/project-tool-plugin')
  await mkdir(plugin, { recursive: true })
  await writeFile(
    join(plugins, 'package.json'),
    JSON.stringify({ dependencies: { 'project-tool-plugin': '1.0.0' } })
  )
  await writeFile(
    join(plugins, 'omp-plugins.lock.json'),
    JSON.stringify({
      plugins: {
        'project-tool-plugin': {
          version: '1.0.0',
          enabled: true,
          enabledFeatures: null
        }
      },
      settings: {}
    })
  )
  await writeFile(
    join(plugin, 'package.json'),
    JSON.stringify({ version: '1.0.0', omp: { tools: './tool.js' } })
  )
  await writeFile(join(plugin, 'tool.js'), 'export default function projectTool() {}\n')

  await assert.rejects(
    async () => {
      const channel = await fixture.factory.open(fixture.params, new AbortController().signal)
      await channel.close()
    },
    (error: unknown) => {
      assert.match(String(error), /project plugin tools/i)
      assert.match(String(error), /project-tool-plugin/)
      assert.match(String(error), /tool\.js/)
      return true
    }
  )
  assert.equal(
    fixture.session.commands.filter((command) => command.includes(' env -i PATH=')).length,
    0
  )
})

test('enabled project plugin feature tools are refused after directory resolution', async (t) => {
  const fixture = await fixtureWithFactory()
  t.after(fixture.cleanup)
  const plugins = join(fixture.cwd, '.omp/plugins')
  const plugin = join(plugins, 'node_modules/feature-tool-plugin')
  await mkdir(join(plugin, 'feature-tools'), { recursive: true })
  await writeFile(
    join(plugins, 'package.json'),
    JSON.stringify({ dependencies: { 'feature-tool-plugin': '1.0.0' } })
  )
  await writeFile(
    join(plugins, 'omp-plugins.lock.json'),
    JSON.stringify({
      plugins: {
        'feature-tool-plugin': {
          version: '1.0.0',
          enabled: true,
          enabledFeatures: ['optional-tools']
        }
      },
      settings: {}
    })
  )
  await writeFile(
    join(plugin, 'package.json'),
    JSON.stringify({
      version: '1.0.0',
      omp: {
        features: {
          'optional-tools': { default: false, tools: ['./feature-tools'] }
        }
      }
    })
  )
  await writeFile(
    join(plugin, 'feature-tools/index.mjs'),
    'export default function featureTool() {}\n'
  )

  await assert.rejects(
    fixture.factory.open(fixture.params, new AbortController().signal),
    (error: unknown) => {
      assert.match(String(error), /project plugin tools/i)
      assert.match(String(error), /feature-tool-plugin/)
      assert.match(String(error), /feature-tools\/index\.mjs/)
      return true
    }
  )
  assert.equal(
    fixture.session.commands.filter((command) => command.includes(' env -i PATH=')).length,
    0
  )
})

test('multiple generations have separate HOME and config and closing one preserves the other and master', async (t) => {
  const fixture = await fixtureWithFactory()
  t.after(fixture.cleanup)
  const first = await fixture.factory.open(fixture.params, new AbortController().signal)
  const second = await fixture.factory.open(
    { ...fixture.params, sessionId: 'session-2' },
    new AbortController().signal
  )
  const base = join(fixture.runtimeRoot, 'rpc-sessions')
  assert.equal((await readdir(base)).length, 2)
  await first.close()
  assert.equal((await readdir(base)).length, 1)
  assert.equal(fixture.session.closed, false)
  await second.close()
  assert.deepEqual(await readdir(base), [])
})

test('foreground child opt-in writes explicit backend and per-compiled-name policy from a snapshotted preparation result', async (t) => {
  const fixture = await fixtureWithFactory()
  t.after(fixture.cleanup)
  const name = `phi_${'a'.repeat(24)}_0_fg`
  const names = [name]
  const nativeTools: Array<'read' | 'task' | 'bash'> = ['read', 'task']
  const transfer = fixture.host.transfer!
  const upload = transfer.uploadFile.bind(transfer)
  transfer.uploadFile = async (source, destination, options) => {
    await upload(source, destination, options)
    if (destination.endsWith('/startup-policy.json')) {
      names.push(`phi_${'b'.repeat(24)}_1_fg`)
      nativeTools.push('bash')
    }
  }
  const factory = await prepareSshRpcSessionTransport({
    session: fixture.session,
    runtime: fixture.options,
    bundle: fixture.bundle,
    projectId: 'project-1',
    prepareRuntime: async () => ({
      nativeTools,
      childRuntimeRequired: true,
      foregroundChildNativeNames: names
    })
  })
  const channel = await factory.open(fixture.params, new AbortController().signal)
  t.after(() => channel.close())
  const base = join(fixture.runtimeRoot, 'rpc-sessions')
  const [nonce] = await readdir(base)
  const path = join(base, nonce, 'startup-policy.json')
  const policy = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(policy.eval, {
    py: false,
    js: false,
    autoProvision: false,
    tools: { enabled: false }
  })
  assert.deepEqual(policy.memory, { backend: 'off' })
  assert.deepEqual(policy.task.agentAdvisor, { [name]: 'off' })
  assert.deepEqual(policy.task.agentPrewalk, { [name]: 'off' })
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const command = fixture.session.commands.find((value) => value.includes(' env -i PATH='))!
  assert.ok(command.includes("'--tools' 'read,task'"))
  assert.ok(!command.includes("'--tools' 'read,task,bash'"))
  assert.ok(command.includes(`'--config' ${shellQuote(path)}`))
  assert.ok(command.includes(`cd -- ${shellQuote(join(base, nonce, 'home'))}`))
})

test('foreground native name preparation is strict and paired, while disabled policy retains its existing defaults', async (t) => {
  const fixture = await fixtureWithFactory()
  t.after(fixture.cleanup)
  const name = `phi_${'a'.repeat(24)}_0_fg`
  const invalid = [
    { nativeTools: ['read', 'task'], childRuntimeRequired: true },
    { nativeTools: ['read', 'task'], childRuntimeRequired: true, foregroundChildNativeNames: [] },
    {
      nativeTools: ['read', 'task'],
      childRuntimeRequired: true,
      foregroundChildNativeNames: [name, name]
    },
    {
      nativeTools: ['read', 'task'],
      childRuntimeRequired: true,
      foregroundChildNativeNames: ['remote-markdown-name']
    },
    {
      nativeTools: ['read', 'task'],
      childRuntimeRequired: true,
      foregroundChildNativeNames: Array.from(
        { length: 33 },
        (_, i) => `phi_${i.toString(16).padStart(24, '0')}_0_fg`
      )
    },
    { nativeTools: ['read'], foregroundChildNativeNames: [name] },
    { nativeTools: ['read'], childRuntimeRequired: false, foregroundChildNativeNames: 'unknown' },
    { nativeTools: ['read'], unexpectedPreparationField: true }
  ]
  for (const raw of invalid) {
    const factory = await prepareSshRpcSessionTransport({
      session: fixture.session,
      runtime: fixture.options,
      bundle: fixture.bundle,
      projectId: 'project-1',
      prepareRuntime: async () => JSON.parse(JSON.stringify(raw))
    })
    await assert.rejects(
      factory.open(fixture.params, new AbortController().signal).then(async (channel) => {
        await channel.close()
        throw new Error('Invalid result unexpectedly opened RPC')
      }),
      /Invalid composed native tool roster/
    )
    await assert.rejects(access(join(fixture.runtimeRoot, 'rpc-sessions')), { code: 'ENOENT' })
  }
  const factory = await prepareSshRpcSessionTransport({
    session: fixture.session,
    runtime: fixture.options,
    bundle: fixture.bundle,
    projectId: 'project-1',
    prepareRuntime: async () => ({
      nativeTools: ['read'],
      childRuntimeRequired: false,
      foregroundChildNativeNames: []
    })
  })
  const channel = await factory.open(fixture.params, new AbortController().signal)
  t.after(() => channel.close())
  const base = join(fixture.runtimeRoot, 'rpc-sessions')
  const [nonce] = await readdir(base)
  assert.deepEqual(JSON.parse(await readFile(join(base, nonce, 'startup-policy.json'), 'utf8')), {
    disabledProviders: ['native', 'claude', 'codex', 'omp-plugins', 'claude-plugins'],
    mcp: { enableProjectConfig: false },
    extensions: [],
    skills: [],
    lsp: { enabled: false },
    memory: { enabled: false },
    tools: { xdev: false }
  })
})

test('stdio acquisition failure removes owned configuration and preserves the connected master', async (t) => {
  const fixture = await fixtureWithFactory()
  t.after(fixture.cleanup)
  fixture.session.openStdio = async () => {
    throw new Error('stdio refused')
  }
  await assert.rejects(
    fixture.factory.open(fixture.params, new AbortController().signal),
    /stdio refused/
  )
  await assert.rejects(access(join(fixture.runtimeRoot, 'rpc-sessions')), { code: 'ENOENT' })
  assert.equal(fixture.session.closed, false)
})

test('a missing managed helper fails startup with the recorded install reason', async (t) => {
  const fixture = await fixtureWithFactory()
  t.after(fixture.cleanup)
  const host = fixture.options.runtimeHost
  host.ensureManagedRemoteHelper = async () => undefined
  host.managedRemoteHelperFailure = () => 'helper upload failed: connection reset'
  await assert.rejects(
    fixture.factory.open(fixture.params, new AbortController().signal),
    /requires the managed helper guard: helper upload failed: connection reset/
  )
  await assert.rejects(access(join(fixture.runtimeRoot, 'rpc-sessions')), { code: 'ENOENT' })
})

test('abort during delayed stdio acquisition closes the late owned channel without closing the master', async (t) => {
  const fixture = await fixtureWithFactory()
  t.after(fixture.cleanup)
  const open = fixture.session.openStdio!
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let closed = false
  let lateClosed!: () => void
  const closedLate = new Promise<void>((resolve) => {
    lateClosed = resolve
  })
  fixture.session.openStdio = async (command) => {
    entered()
    await held
    const channel = await open(command)
    return {
      ...channel,
      async close() {
        closed = true
        await channel.close()
        lateClosed()
      }
    }
  }
  const controller = new AbortController()
  const opening = fixture.factory.open(fixture.params, controller.signal)
  await started
  const rejected = assert.rejects(opening, { name: 'AbortError' })
  controller.abort()
  try {
    await Promise.race([
      rejected,
      delay(1000).then(() => {
        throw new Error('Pending stdio cancellation did not settle before gate release')
      })
    ])
    await assert.rejects(access(join(fixture.runtimeRoot, 'rpc-sessions')), { code: 'ENOENT' })
    assert.equal(closed, false)
  } finally {
    release()
  }
  await closedLate
  assert.equal(closed, true)
  await assert.rejects(access(join(fixture.runtimeRoot, 'rpc-sessions')), { code: 'ENOENT' })
  assert.equal(fixture.session.closed, false)
})

test('R3 preparation receives only the owned private generation and its failure cleans up without opening RPC stdio', async (t) => {
  const fixture = await fixtureWithFactory()
  t.after(fixture.cleanup)
  let prepared = false
  let opened = false
  const open = fixture.session.openStdio!
  fixture.session.openStdio = async (command) => {
    if (command.includes(' env -i PATH=')) {
      opened = true
      throw new Error('unexpected RPC channel')
    }
    return open(command)
  }
  const factory = await prepareSshRpcSessionTransport({
    session: fixture.session,
    runtime: fixture.options,
    bundle: fixture.bundle,
    projectId: 'project-1',
    prepareSession: async ({ params, homePath, agentDir, signal }) => {
      prepared = true
      assert.equal(params, fixture.params)
      assert.equal(agentDir, join(homePath, 'agent'))
      assert.ok(agentDir.startsWith(join(fixture.runtimeRoot, 'rpc-sessions') + '/'))
      assert.equal(signal.aborted, false)
      throw new Error('proxy preparation failed')
    }
  })
  await assert.rejects(
    factory.open(fixture.params, new AbortController().signal),
    /proxy preparation failed/
  )
  assert.equal(prepared, true)
  assert.equal(opened, false)
  await assert.rejects(access(join(fixture.runtimeRoot, 'rpc-sessions')), { code: 'ENOENT' })
  assert.equal(fixture.session.closed, false)
})

test('invalid identities and missing persistent stdio fail before deploying or copying configuration', async (t) => {
  const fixture = await fixtureWithFactory()
  t.after(fixture.cleanup)
  const commands = fixture.session.commands.length
  await assert.rejects(
    prepareSshRpcSessionTransport({
      session: {},
      runtime: fixture.options,
      bundle: fixture.bundle,
      projectId: 'project-1'
    }),
    /persistent stdio capability/
  )
  await assert.rejects(
    prepareSshRpcSessionTransport({
      session: fixture.session,
      runtime: fixture.options,
      bundle: fixture.bundle,
      projectId: 'bad identity'
    }),
    /project identity/
  )
  await assert.rejects(
    fixture.factory.open({ ...fixture.params, sessionId: 'bad id' }, new AbortController().signal),
    /session identity/
  )
  assert.equal(fixture.session.commands.length, commands)
})

test('reserved discovery provider names cannot silently disable the selected Phi model', async (t) => {
  const fixture = await fixtureWithFactory()
  t.after(fixture.cleanup)
  await assert.rejects(
    fixture.factory.open(
      {
        ...fixture.params,
        model: {
          provider: 'native',
          id: 'contract-model',
          name: 'Conflicting model',
          reasoning: false,
          supportsImages: false
        }
      },
      new AbortController().signal
    ),
    /model provider "native" conflicts with Phi's disabled capability providers/i
  )
  assert.equal(
    fixture.session.commands.filter((command) => command.includes(' env -i PATH=')).length,
    0
  )
})

test('slow shared deployment precedes the short connection deadline; actual CLI attests and closes only its owned channel', async (t) => {
  const bun = join(process.env.HOME!, '.bun/bin/bun')
  const cli = join(process.cwd(), 'node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js')
  const networkGuard = join(process.cwd(), 'tests/engine-contract/network-guard.ts')
  const fixture = await fixtureWithFactory(
    runtimePayload(
      `exec ${shellQuote(bun)} --no-env-file --preload ${shellQuote(networkGuard)} ${shellQuote(cli)} "$@"`
    )
  )
  t.after(fixture.cleanup)
  const provider = await startLoopbackModel()
  t.after(provider.close)
  const bundle = await createPhiExtensionBundle(
    join(process.cwd(), 'src/main/agent/engine/phi-extension')
  )
  const outsideSentinel = join(fixture.root, 'startup-command-outside-project')
  const extensionSentinel = join(fixture.root, 'ambient-extension-outside-project')
  const ambientExtension = join(fixture.cwd, 'ambient-extension.ts')
  await writeFile(
    ambientExtension,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(extensionSentinel)}, 'executed'); export default function() {}`
  )
  await writeFile(
    join(fixture.cwd, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        unsafe: {
          command: '/bin/sh',
          args: ['-c', `printf executed > ${shellQuote(outsideSentinel)}`]
        }
      }
    })
  )
  await mkdir(join(fixture.cwd, '.omp'))
  await writeFile(
    join(fixture.cwd, '.omp/config.yml'),
    JSON.stringify({
      mcp: { enableProjectConfig: true },
      extensions: [ambientExtension],
      prewalk: { enabled: true },
      lsp: { enabled: true }
    })
  )
  const upload = fixture.host.transfer.uploadFile
  let delayed = false
  fixture.host.transfer.uploadFile = async (...args) => {
    if (!delayed) {
      delayed = true
      await delay(5250, undefined, { signal: args[2]?.signal })
    }
    await upload(...args)
  }
  const preparationStarted = performance.now()
  const factory = await prepareSshRpcSessionTransport({
    session: fixture.session,
    runtime: fixture.options,
    bundle,
    projectId: 'project-1',
    prepareSession: async ({ agentDir, startup }) => {
      startup.addFile({
        item: 'slow-models',
        path: join(agentDir, 'models.yml'),
        bytes: Buffer.from(
          JSON.stringify({
            providers: {
              'phi-contract': {
                baseUrl: provider.url,
                api: 'openai-completions',
                apiKey: 'contract-only-key',
                models: [
                  {
                    id: 'contract-model',
                    name: 'Contract Model',
                    reasoning: false,
                    input: ['text'],
                    contextWindow: 32768,
                    maxTokens: 256,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
                  }
                ]
              }
            }
          })
        ),
        mode: 0o600,
        ifAbsent: true
      })
      startup.addFile({
        item: 'slow-config',
        path: join(agentDir, 'config.yml'),
        bytes: Buffer.from(
          JSON.stringify({
            defaultProvider: 'phi-contract',
            defaultModel: 'contract-model',
            compaction: { enabled: false },
            memory: { enabled: false },
            extensions: [],
            skills: []
          })
        ),
        mode: 0o600,
        ifAbsent: true
      })
    }
  })
  assert.equal(delayed, false)
  assert.ok(performance.now() - preparationStarted < 1000)
  let stderr = ''
  const open = fixture.session.openStdio!
  fixture.session.openStdio = async (command) => {
    const channel = await open(command)
    channel.stderr.on('data', (bytes: Buffer) => {
      stderr = (stderr + bytes.toString()).slice(-8000)
    })
    return channel
  }
  const backend = new RpcSessionBackend(factory.open, {
    initialize: factory.initialize,
    startupTimeoutMs: 5000
  })
  t.after(() => backend.dispose({ sessionId: fixture.params.sessionId }))
  const phases: string[] = []
  backend.onSessionStatus(fixture.params.sessionId, (status) => phases.push(status.phase))
  const created = await backend.create(fixture.params).catch((error: unknown) => {
    throw new Error(`Real CLI bootstrap failed: ${stderr}`, { cause: error })
  })
  assert.equal(delayed, true)
  assert.equal(created.sessionId, fixture.params.sessionId)
  assert.equal(created.state.cwd, fixture.cwd)
  assert.deepEqual(phases, ['ready'])
  assert.equal(provider.requests.length, 0)
  await assert.rejects(access(outsideSentinel), { code: 'ENOENT' })
  await assert.rejects(access(extensionSentinel), { code: 'ENOENT' })
  await backend.dispose({ sessionId: fixture.params.sessionId })
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'rpc-sessions')), [])
  assert.equal(fixture.session.closed, false)
  assert.equal((await fixture.session.exec('printf still-connected')).stdout, 'still-connected')
})

test('repair preparation has independent cancellation and never opens a session channel or private config when cancelled', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const session = createLocalShellSession(fixture.runtimeRoot)
  t.after(() => session.close())
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const controller = new AbortController()
  const factory = await prepareSshRpcSessionTransport(
    {
      session,
      runtime: {
        ...fixture.options,
        fetchImpl: async (_input, init) => {
          entered()
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true
            })
          })
        }
      },
      bundle: fixture.bundle,
      projectId: 'project-1'
    },
    controller.signal
  )
  const opening = factory.open(
    { sessionId: 'cancelled-session', cwd: fixture.root, agentDir: 'unused' },
    controller.signal
  )
  await started
  const rejected = assert.rejects(opening, { name: 'AbortError' })
  controller.abort()
  await rejected
  assert.equal(
    session.commands.some((command) => command.includes(' env -i PATH=')),
    false
  )
  assert.equal(session.closed, false)
  await assert.rejects(access(join(fixture.runtimeRoot, 'rpc-sessions')), { code: 'ENOENT' })
  assert.deepEqual(await readdir(join(fixture.options.cacheDir, 'omp/18.10.3/linux-x64')), [])
})

async function environmentProbe(connection: RpcConnection): Promise<Record<string, unknown>> {
  const available = (await connection.request({ type: 'get_available_commands' })) as {
    commands: Array<{ name: string; source: string }>
  }
  assert.equal(
    available.commands.filter(
      (command) => command.name === 'phi-rpc-env-probe' && command.source === 'extension'
    ).length,
    1
  )
  const nonce = 'synthetic-env-challenge'
  let received!: (value: Record<string, unknown>) => void
  const notification = new Promise<Record<string, unknown>>((resolve) => {
    received = resolve
  })
  const detach = connection.onEvent((frame) => {
    if (
      frame.type !== 'extension_ui_request' ||
      frame.method !== 'notify' ||
      typeof frame.message !== 'string'
    )
      return
    const value = JSON.parse(frame.message) as Record<string, unknown>
    if (value.type === 'phi_rpc_environment_probe' && value.nonce === nonce) received(value)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const [result, value] = await Promise.all([
      connection.prompt(`/phi-rpc-env-probe ${nonce}`),
      Promise.race([
        notification,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Synthetic environment probe timed out')), 1000)
        })
      ])
    ])
    assert.equal(result.agentInvoked, false)
    assert.equal(result.status, 'completed')
    return value
  } finally {
    if (timer) clearTimeout(timer)
    detach()
  }
}

test('neutral private startup prevents SDK dotenv injection even with runtime inside project and keeps real project cwd', async (t) => {
  const bun = join(process.env.HOME!, '.bun/bin/bun')
  const cli = join(process.cwd(), 'node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js')
  const guard = join(process.cwd(), 'tests/engine-contract/network-guard.ts')
  // Official binaries compile with autoloadDotenv:false. This source CLI fixture
  // disables only Bun's loader; the real SDK eager reader remains untouched.
  const fixture = await fixtureWithFactory(
    runtimePayload(
      `exec ${shellQuote(bun)} --no-env-file --preload ${shellQuote(guard)} ${shellQuote(cli)} "$@"`
    ),
    true
  )
  t.after(fixture.cleanup)
  assert.ok(fixture.runtimeRoot.startsWith(`${fixture.cwd}/`))
  await writeFile(
    join(fixture.cwd, '.env'),
    'PHI_RPC_DOTENV_TEST_MARKER=SYNTHETIC_PROJECT_VALUE\nPI_REQ_DEBUG=1\n'
  )
  const source = join(fixture.root, 'phi-environment-probe')
  await cp(join(process.cwd(), 'src/main/agent/engine/phi-extension'), source, { recursive: true })
  await rename(join(source, 'rpc-entry.ts'), join(source, 'phi-entry.ts'))
  await cp(
    join(process.cwd(), 'tests/engine-contract/rpc-environment-probe.ts'),
    join(source, 'environment-probe.ts')
  )
  await writeFile(
    join(source, 'rpc-entry.ts'),
    "import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'\nimport original from './phi-entry'\nimport probe from './environment-probe'\nconst entry: ExtensionFactory = async pi => { await probe(pi); await original(pi) }\nexport default entry\n"
  )
  const provider = await startLoopbackModel()
  t.after(provider.close)
  const factory = await prepareSshRpcSessionTransport({
    session: fixture.session,
    runtime: fixture.options,
    bundle: await createPhiExtensionBundle(source),
    projectId: 'project-1',
    prepareSession: async ({ agentDir, startup }) => {
      startup.addFile({
        item: 'environment-models',
        path: join(agentDir, 'models.yml'),
        bytes: Buffer.from(
          JSON.stringify({
            providers: {
              'phi-env-fixture': {
                baseUrl: provider.url,
                api: 'openai-completions',
                apiKey: 'synthetic-only-key',
                models: [
                  {
                    id: 'no-call',
                    name: 'No-call fixture',
                    reasoning: false,
                    input: ['text'],
                    contextWindow: 32768,
                    maxTokens: 256,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
                  }
                ]
              }
            }
          })
        ),
        mode: 0o600,
        ifAbsent: true
      })
      startup.addFile({
        item: 'environment-config',
        path: join(agentDir, 'config.yml'),
        bytes: Buffer.from(
          JSON.stringify({
            defaultProvider: 'phi-env-fixture',
            defaultModel: 'no-call',
            compaction: { enabled: false },
            memory: { enabled: false },
            extensions: [],
            skills: []
          })
        ),
        mode: 0o600,
        ifAbsent: true
      })
    }
  })
  const params = Object.freeze({ ...fixture.params })
  const owned = await factory.open(params, new AbortController().signal)
  const connection = new RpcConnection(() => owned, { startupTimeoutMs: 5000 })
  t.after(() => connection.close())
  await connection.start()
  await factory.initialize({ connection, params, signal: new AbortController().signal })
  const neutral = await environmentProbe(connection)
  assert.equal(neutral.marker, null)
  assert.equal(neutral.debug, '0')
  assert.equal(await realpath(String(neutral.processCwd)), fixture.cwd)
  assert.equal(await realpath(String(neutral.contextCwd)), fixture.cwd)
  const shell = (await connection.request({ type: 'bash', command: 'pwd' })) as {
    output: string
    exitCode: number
  }
  assert.equal(shell.exitCode, 0)
  assert.equal(await realpath(shell.output.trim()), fixture.cwd)
  const [generation] = await readdir(join(fixture.runtimeRoot, 'rpc-sessions'))
  const privateRoot = join(fixture.runtimeRoot, 'rpc-sessions', generation)
  const launch = fixture.session.commands.find(
    (command) =>
      command.includes(' env -i PATH=') &&
      command.includes(`HOME=${shellQuote(join(privateRoot, 'home'))}`)
  )!
  const direct = launch.replace(
    `cd -- ${shellQuote(join(privateRoot, 'home'))}`,
    `cd -- ${shellQuote(fixture.cwd)}`
  )
  assert.notEqual(direct, launch)
  const positiveChannel = await fixture.session.openStdio!(direct)
  const positive = new RpcConnection(() => positiveChannel, { startupTimeoutMs: 5000 })
  t.after(() => positive.close())
  await positive.start()
  const config = JSON.parse(
    await readFile(join(privateRoot, 'config.json'), 'utf8')
  ) as RpcBootstrapConfig
  await attestBootstrap(positive, config, new AbortController().signal)
  const control = await environmentProbe(positive)
  assert.equal(control.marker, 'SYNTHETIC_PROJECT_VALUE')
  assert.equal(control.debug, '0')
  assert.equal(await realpath(String(control.processCwd)), fixture.cwd)
  assert.equal(await realpath(String(control.contextCwd)), fixture.cwd)
  assert.equal(provider.requests.length, 0)
  await positive.close()
  await connection.close()
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'rpc-sessions')), [])
  assert.equal(fixture.session.closed, false)
})
