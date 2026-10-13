import assert from 'node:assert/strict'
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
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
import { startLoopbackModel } from './engine-contract/loopback-model'

function runtimePayload(body: string): string {
  return `#!/bin/sh\nif [ "$1" = --version ]; then printf 'omp/18.10.3\\n'; exit 0; fi\n${body}\n`
}

async function fixtureWithFactory(payload = runtimePayload('cat')): Promise<
  Awaited<ReturnType<typeof createPhiExtensionDeploymentFixture>> & {
    session: ReturnType<typeof createLocalShellSession>
    cwd: string
    params: RpcSessionCreateParams
    factory: SshRpcSessionTransport
  }
> {
  const fixture = await createPhiExtensionDeploymentFixture(payload)
  const cwd = join(fixture.root, "project user's $(touch MUST_NOT_EXIST)")
  await mkdir(cwd)
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
  const command = fixture.session.commands.find((value) => value.includes('exec env -i'))!
  assert.ok(command.includes(`cd -- ${shellQuote(fixture.cwd)}`))
  assert.ok(command.includes(`PHI_RPC_CONFIG=${shellQuote(configPath)}`))
  assert.ok(command.includes("'--no-extensions' '--trusted-extension'"))
  assert.ok(command.includes("'--trusted-extension'"))
  assert.ok(command.includes(`'--config' ${shellQuote(join(privateRoot, 'startup-policy.json'))}`))
  assert.ok(command.includes("'--no-skills' '--no-rules' '--no-lsp'"))
  assert.ok(!command.includes('--no-ui'))
  assert.ok(!command.includes(fixture.params.agentDir))
  assert.deepEqual(JSON.parse(await readFile(join(privateRoot, 'startup-policy.json'), 'utf8')), {
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
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'rpc-sessions')), [])
  assert.equal(fixture.session.closed, false)
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
    assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'rpc-sessions')), [])
    assert.equal(closed, false)
  } finally {
    release()
  }
  await closedLate
  assert.equal(closed, true)
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'rpc-sessions')), [])
  assert.equal(fixture.session.closed, false)
})

test('R3 preparation receives only the owned private generation and its failure cleans up without opening RPC stdio', async (t) => {
  const fixture = await fixtureWithFactory()
  t.after(fixture.cleanup)
  let prepared = false
  let opened = false
  const open = fixture.session.openStdio!
  fixture.session.openStdio = async (command) => {
    if (command.includes('exec env -i')) {
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
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'rpc-sessions')), [])
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

test('slow shared deployment precedes the short connection deadline; actual CLI attests and closes only its owned channel', async (t) => {
  const bun = join(process.env.HOME!, '.bun/bin/bun')
  const cli = join(process.cwd(), 'node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js')
  const networkGuard = join(process.cwd(), 'tests/engine-contract/network-guard.ts')
  const fixture = await fixtureWithFactory(
    runtimePayload(
      `exec ${shellQuote(bun)} --preload ${shellQuote(networkGuard)} ${shellQuote(cli)} "$@"`
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
    prepareSession: async ({ agentDir }) => {
      await writeFile(
        join(agentDir, 'models.yml'),
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
        }),
        { mode: 0o600 }
      )
      await writeFile(
        join(agentDir, 'config.yml'),
        JSON.stringify({
          defaultProvider: 'phi-contract',
          defaultModel: 'contract-model',
          compaction: { enabled: false },
          memory: { enabled: false },
          extensions: [],
          skills: []
        }),
        { mode: 0o600 }
      )
    }
  })
  assert.equal(delayed, true)
  assert.ok(performance.now() - preparationStarted >= 5250)
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

test('shared preparation has independent cancellation and never opens a session channel or private config when cancelled', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const session = createLocalShellSession(fixture.runtimeRoot)
  t.after(() => session.close())
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const controller = new AbortController()
  const preparing = prepareSshRpcSessionTransport(
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
  await started
  const rejected = assert.rejects(preparing, { name: 'AbortError' })
  controller.abort()
  await rejected
  assert.equal(session.commands.length, 0)
  assert.equal(session.closed, false)
  await assert.rejects(access(join(fixture.runtimeRoot, 'rpc-sessions')), { code: 'ENOENT' })
  assert.deepEqual(await readdir(join(fixture.options.cacheDir, 'omp/18.10.3/linux-x64')), [])
})
