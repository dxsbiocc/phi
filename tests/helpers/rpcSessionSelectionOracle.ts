import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import { OmpBridge, type OwnedModelGatewayLease } from '../../src/main/agent/engine/omp-bridge'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import { attestBootstrap } from '../../src/main/agent/engine/rpc/bootstrap-attestation'
import { selectRemoteModel } from '../../src/main/agent/engine/rpc/model-selection'
import { serializeRemoteModelProxyConfig } from '../../src/main/agent/engine/rpc/model-proxy-config'
import type { RpcModelMetadata } from '../../src/main/agent/engine/phi-extension/lib/rpc-model-metadata'
import type { RpcFrame, RpcTransport } from '../../src/main/agent/engine/rpc/types'
import { createRpcModelSelectionFixture } from './rpcModelSelectionFixture'

export interface SelectionState {
  sessionId: string
  sessionFile: string
  model: {
    provider: string
    id: string
    reasoning: boolean
    contextWindow: number
    maxTokens: number
  }
  thinkingLevel?: string
  isStreaming: boolean
  autoCompactionEnabled: boolean
}

/** Real desktop SDK gateway + private published config + official RPC CLI; no fabricated session. */
export async function rpcSessionSelectionOracle(): Promise<{
  base: Awaited<ReturnType<typeof createRpcModelSelectionFixture>>
  metadata: RpcModelMetadata
  candidate: RpcModelMetadata['models'][number]
  frames: RpcFrame[]
  readonly connection: RpcConnection
  state(): Promise<SelectionState>
  messages(): Promise<unknown[]>
  journal(): Promise<Array<Record<string, unknown>>>
  select(index: number): Promise<void>
  thinking(level?: unknown): Promise<void>
  refresh(): Promise<void>
  reopen(sessionFile: string): Promise<void>
  disconnect(): void
  close(): Promise<void>
}> {
  const base = await createRpcModelSelectionFixture()
  let bridge: OmpBridge | undefined
  let lease: OwnedModelGatewayLease | undefined
  let connection: RpcConnection
  let closing: Promise<void> | undefined
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      let failed = false
      let failure: unknown
      for (const dispose of [
        () => connection?.close(),
        () => lease?.close(),
        () => bridge?.stop(),
        () => base.close()
      ]) {
        try {
          await dispose()
        } catch (error) {
          if (!failed) {
            failed = true
            failure = error
          }
        }
      }
      if (failed) throw failure
    })())
  try {
    const desktopAgent = join(base.root, 'desktop-agent')
    const desktopHome = join(base.root, 'desktop-home')
    await mkdir(desktopAgent)
    await mkdir(desktopHome)
    const definitions = base.metadata.models.slice(0, 3).map((model, index) => ({
      id: model.id,
      name: model.name,
      reasoning: index !== 0,
      input: ['text'],
      contextWindow: 32768 + index * 32768,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { thinkingFormat: 'openai' }
    }))
    const provider = base.metadata.models[0].provider
    await writeFile(
      join(desktopAgent, 'models.yml'),
      JSON.stringify({
        providers: {
          [provider]: {
            api: 'openai-completions',
            baseUrl: base.provider.url,
            apiKey: 'isolated-selection-contract-key',
            models: definitions
          }
        }
      }),
      { mode: 0o600 }
    )
    const bun = resolveBunExecutable()
    const guard = fileURLToPath(new URL('../engine-contract/network-guard.ts', import.meta.url))
    bridge = new OmpBridge(() =>
      spawn(
        bun,
        [
          '--no-env-file',
          '--preload',
          guard,
          fileURLToPath(new URL('../../src/main/agent/engine/in-process/main.ts', import.meta.url))
        ],
        {
          cwd: base.cwd,
          env: {
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            HOME: desktopHome,
            PI_CODING_AGENT_DIR: desktopAgent,
            TMPDIR: join(base.root, 'tmp'),
            XDG_CONFIG_HOME: join(desktopHome, '.config'),
            XDG_CACHE_HOME: join(desktopHome, '.cache'),
            XDG_DATA_HOME: join(desktopHome, '.local/share'),
            NO_PROXY: '127.0.0.1,localhost'
          },
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
    )
    lease = await bridge.createModelGatewayLease({
      sessionId: base.config.sessionId,
      generation: 1,
      models: definitions.slice(0, 2).map(({ id }) => ({ provider, id }))
    })
    const metadata: RpcModelMetadata = { ...base.metadata, models: lease.models }
    const candidate = {
      ...lease.models[1],
      id: definitions[2].id,
      name: definitions[2].name,
      contextWindow: definitions[2].contextWindow
    }
    await writeFile(base.metadataPath, JSON.stringify(metadata), { mode: 0o600 })
    await writeFile(
      join(base.agentDir, 'models.yml'),
      serializeRemoteModelProxyConfig({
        models: lease.models,
        remotePort: lease.localPort,
        gatewayBearer: lease.bearerToken
      }),
      { mode: 0o600 }
    )
    const refreshPath = join(base.root, 'selection-refresh-extension.ts')
    await writeFile(
      refreshPath,
      `export default pi => pi.registerCommand('selection-oracle-refresh', {
    description: 'Private selection oracle public registry refresh',
    handler: async (_args, ctx) => { await ctx.modelRegistry.refresh('offline'); }
  });`,
      { mode: 0o600 }
    )
    const frames: RpcFrame[] = []
    let child: ChildProcessWithoutNullStreams | undefined
    const open = async (sessionFile?: string): Promise<RpcConnection> => {
      let transport: RpcTransport | undefined
      const next = new RpcConnection(
        () => {
          const process = spawn(
            bun,
            [
              '--no-env-file',
              '--preload',
              guard,
              fileURLToPath(
                new URL('../dist/cli.js', import.meta.resolve('@oh-my-pi/pi-coding-agent'))
              ),
              '--mode',
              'rpc',
              '--no-extensions',
              '--no-skills',
              '--no-rules',
              '--no-title',
              '--no-prewalk',
              '--no-lsp',
              '--no-pty',
              '--no-tools',
              '--trusted-extension',
              fileURLToPath(
                new URL('../../src/main/agent/engine/phi-extension/rpc-entry.ts', import.meta.url)
              ),
              '--trusted-extension',
              refreshPath,
              ...(sessionFile
                ? ['--session', sessionFile]
                : ['--provider', provider, '--model', definitions[0].id])
            ],
            {
              cwd: base.cwd,
              env: {
                PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
                HOME: base.home,
                PI_CODING_AGENT_DIR: base.agentDir,
                PI_CODING_AGENT_SESSION_DIR: join(base.root, 'history'),
                PHI_RPC_CONFIG: base.configPath,
                TMPDIR: join(base.root, 'tmp'),
                XDG_CONFIG_HOME: join(base.home, '.config'),
                XDG_CACHE_HOME: join(base.home, '.cache'),
                XDG_DATA_HOME: join(base.home, '.local/share'),
                NO_PROXY: '127.0.0.1,localhost'
              },
              stdio: ['pipe', 'pipe', 'pipe']
            }
          )
          child = process
          process.stderr.resume()
          const closed = new Promise<{ code: number | null; signal: string | null }>(
            (resolve, reject) => {
              process.once('error', reject)
              process.once('close', (code, signal) => resolve({ code, signal }))
            }
          )
          let closing: Promise<void> | undefined
          transport = {
            stdin: process.stdin,
            stdout: process.stdout,
            stderr: process.stderr,
            closed,
            close: () =>
              (closing ??= (async () => {
                if (process.exitCode !== null || process.signalCode !== null) return
                process.kill('SIGTERM')
                const timer = setTimeout(() => process.kill('SIGKILL'), 2000)
                try {
                  await closed
                } finally {
                  clearTimeout(timer)
                }
              })())
          }
          return transport
        },
        { startupTimeoutMs: 15000, requestTimeoutMs: 10000, promptTimeoutMs: 15000 }
      )
      next.onEvent((frame) => frames.push(frame))
      try {
        await next.start()
        await attestBootstrap(next, base.config, new AbortController().signal)
        return next
      } catch (error) {
        await next.close().catch(() => {})
        await transport?.close().catch(() => {})
        throw error
      }
    }
    connection = await open()
    return {
      base,
      metadata,
      candidate,
      frames,
      get connection() {
        return connection
      },
      state: () => connection.request<SelectionState>({ type: 'get_state' }),
      messages: async () =>
        (await connection.request<{ messages: unknown[] }>({ type: 'get_messages' })).messages,
      journal: async () => {
        const state = await connection.request<SelectionState>({ type: 'get_state' })
        return (await readFile(state.sessionFile, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      },
      select: (index) =>
        selectRemoteModel(
          connection,
          metadata,
          metadata.models[index],
          new AbortController().signal
        ),
      thinking: async (level) => {
        await connection.request({
          type: 'set_thinking_level',
          ...(level === undefined ? {} : { level })
        })
      },
      refresh: async () => {
        const result = await connection.prompt('/selection-oracle-refresh')
        if (result.agentInvoked || result.status !== 'completed')
          throw new Error('Public catalog refresh failed')
      },
      async reopen(sessionFile) {
        await connection.close()
        connection = await open(sessionFile)
      },
      disconnect() {
        child?.kill('SIGKILL')
      },
      close
    }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
