import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import type { RpcFrame, RpcTransport } from '../../src/main/agent/engine/rpc/types'
import type {
  SessionVerificationIdentity,
  SessionVerificationBudgets
} from '../../src/main/agent/engine/phi-extension/lib/rpc-session-verification-protocol'
import { createRpcSessionVerifier } from '../../src/main/agent/engine/rpc/session-verification'
import type { RemoteSessionReference } from '../../src/main/agent/engine/rpc/session-storage/types'

export async function createSessionVerificationFixture(
  budgets?: SessionVerificationBudgets,
  options: { isolatedProject?: boolean } = {}
): Promise<{
  root: string
  identity: SessionVerificationIdentity
  connection: RpcConnection
  readonly verifier: ReturnType<typeof createRpcSessionVerifier>
  frames: RpcFrame[]
  stderr(): string
  running(): boolean
  fixtureCommand(command: string): Promise<Record<string, unknown> | undefined>
  reference(value: Record<string, unknown>): RemoteSessionReference
  bytes(path: string): Promise<Buffer>
  close(): Promise<void>
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-session-verifier-fixture-')))
  const home = join(root, 'home'),
    projectRoot = options.isolatedProject
      ? await realpath(await mkdtemp(join(tmpdir(), 'phi-session-proof-project-')))
      : join(root, 'project'),
    directory = join(root, 'durable')
  const journals = join(directory, 'journals'),
    blobs = join(directory, 'data/omp/blobs')
  const identity: SessionVerificationIdentity = {
    nonce: 'n'.repeat(32),
    phiSessionId: 'phi-proof',
    generation: 1,
    projectRoot,
    directory,
    journals,
    blobs
  }
  for (const path of [
    home,
    projectRoot,
    directory,
    journals,
    join(directory, 'data'),
    join(directory, 'data/omp'),
    blobs,
    join(home, '.omp'),
    join(home, '.omp/agent'),
    join(root, 'tmp')
  ])
    if (path !== projectRoot || !options.isolatedProject) await mkdir(path, { mode: 0o700 })
  const agent = join(home, '.omp/agent'),
    config = join(root, 'capability.json')
  await writeFile(config, JSON.stringify({ ...identity, ...(budgets ? { budgets } : {}) }), {
    mode: 0o600
  })
  await writeFile(
    join(agent, 'models.yml'),
    JSON.stringify({
      providers: {
        fixture: {
          api: 'openai-completions',
          apiKey: 'synthetic-unused',
          baseUrl: 'http://127.0.0.1:1/v1',
          models: ['old', 'current', 'discarded', 'small', 'temporary'].map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ['text', 'image'],
            contextWindow: 32768,
            maxTokens: 256
          }))
        }
      }
    }),
    { mode: 0o600 }
  )
  await writeFile(
    join(agent, 'config.yml'),
    JSON.stringify({
      compaction: { enabled: false },
      goal: { continuationModes: [] },
      retry: { modelFallback: false },
      memory: { enabled: false },
      mcp: { enableProjectConfig: false },
      extensions: [],
      skills: []
    }),
    { mode: 0o600 }
  )
  let stderr = '',
    running = false
  const frames: RpcFrame[] = []
  let transport: RpcTransport | undefined
  const connection = new RpcConnection(
    () => {
      const child = spawn(
        '/bin/sh',
        [
          '-c',
          'umask 077; exec "$@"',
          'phi-verifier-fixture',
          resolveBunExecutable(),
          '--preload',
          fileURLToPath(new URL('../engine-contract/network-guard.ts', import.meta.url)),
          fileURLToPath(
            new URL('../dist/cli.js', import.meta.resolve('@oh-my-pi/pi-coding-agent'))
          ),
          '--mode',
          'rpc',
          '--provider',
          'fixture',
          '--model',
          'current',
          '--session-dir',
          journals,
          '--no-extensions',
          '--no-skills',
          '--no-rules',
          '--tools',
          'bash',
          '--no-title',
          '--no-prewalk',
          '--no-lsp',
          '--no-pty',
          '--trusted-extension',
          fileURLToPath(new URL('./rpcSessionVerificationExtension.ts', import.meta.url))
        ],
        {
          cwd: projectRoot,
          env: {
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            HOME: home,
            USERPROFILE: home,
            PI_CODING_AGENT_DIR: agent,
            XDG_DATA_HOME: join(directory, 'data'),
            XDG_CONFIG_HOME: join(home, '.config'),
            XDG_CACHE_HOME: join(root, 'cache'),
            XDG_STATE_HOME: join(root, 'state'),
            TMPDIR: join(root, 'tmp'),
            TMP: join(root, 'tmp'),
            TEMP: join(root, 'tmp'),
            PHI_VERIFIER_FIXTURE: config
          },
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
      running = true
      child.stderr.on('data', (bytes) => {
        stderr += bytes.toString()
      })
      const closed = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => {
            running = false
            resolve({ code, signal })
          })
        }
      )
      let closing: Promise<void> | undefined
      transport = {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        closed,
        close: () =>
          (closing ??= (async () => {
            if (child.exitCode !== null || child.signalCode !== null) return
            child.kill('SIGTERM')
            const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
            try {
              await closed
            } finally {
              clearTimeout(timer)
            }
          })())
      }
      return transport
    },
    { startupTimeoutMs: 15000, requestTimeoutMs: 15000, promptTimeoutMs: 30000 }
  )
  connection.onEvent((frame) => frames.push(frame))
  try {
    await connection.start()
  } catch (error) {
    await transport?.close()
    if (options.isolatedProject) await rm(projectRoot, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
    throw new Error(stderr, { cause: error })
  }
  const fixtureCommand = async (command: string): Promise<Record<string, unknown> | undefined> => {
    const offset = frames.length
    const result = await connection.prompt('/phi-verifier-fixture ' + command)
    if (result.agentInvoked || result.status !== 'completed')
      throw new Error(JSON.stringify({ result, stderr }))
    for (const frame of frames.slice(offset))
      if (frame.type === 'extension_ui_request' && typeof frame.message === 'string') {
        const value = JSON.parse(frame.message)
        if (String(value.type).startsWith('fixture_')) return value
      }
    return undefined
  }
  return {
    root,
    identity,
    connection,
    get verifier() {
      // Every service-only inspection is an independent restore attempt. Tests
      // for saved-to-attachment baselines retain this returned instance.
      return createRpcSessionVerifier({
        connection,
        control: connection.bindControl(),
        identity,
        assertActive: () => undefined
      })
    },
    frames,
    stderr: () => stderr,
    running: () => running,
    fixtureCommand,
    reference(value: Record<string, unknown>): RemoteSessionReference {
      return {
        kind: 'remote-omp',
        version: 1,
        ompVersion: '18.10.3',
        hostProfileId: 'fixture-host',
        bindingHash: 'a'.repeat(64),
        projectId: 'project',
        runtimeRoot: root,
        projectRoot,
        phiSessionId: identity.phiSessionId,
        durableSessionKey: 'fixture',
        ompSessionId: value.id as string,
        journalBasename: (value.path as string).split('/').pop()!
      }
    },
    async bytes(path: string) {
      return readFile(path)
    },
    async close() {
      try {
        if (running) {
          const stats = await fixtureCommand('stats')
          if (stats?.providerCalls !== 0)
            throw new Error('Verifier unexpectedly invoked a provider')
        }
        await connection.close()
      } finally {
        try {
          await transport?.close()
        } finally {
          if (options.isolatedProject) await rm(projectRoot, { recursive: true, force: true })
          await rm(root, { recursive: true, force: true })
        }
      }
    }
  }
}
