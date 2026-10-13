import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import type { RpcBootstrapConfig } from '../../src/main/agent/engine/phi-extension/lib/rpc-config'
import {
  RPC_MODEL_METADATA_FILENAME,
  type RpcModelMetadata
} from '../../src/main/agent/engine/phi-extension/lib/rpc-model-metadata'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type { RpcFrame, RpcTransport } from '../../src/main/agent/engine/rpc/types'
import { startLoopbackModel } from '../engine-contract/loopback-model'

interface RpcModelSelectionFixture {
  root: string
  cwd: string
  home: string
  agentDir: string
  configPath: string
  metadataPath: string
  config: RpcBootstrapConfig
  metadata: RpcModelMetadata
  connection: RpcConnection
  provider: Awaited<ReturnType<typeof startLoopbackModel>>
  frames: RpcFrame[]
  running(): boolean
  stderr(): string
  close(): Promise<void>
}

/** A private official CLI, synthetic gateway bearer, and a loopback-only zero-request oracle. */
export async function createRpcModelSelectionFixture(
  options: { provider?: string } = {}
): Promise<RpcModelSelectionFixture> {
  const providerName = options.provider ?? 'phi-selection'
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-rpc-model-')))
  const nonce = randomUUID()
  const cwd = join(root, 'project')
  const home = join(root, 'rpc-sessions', nonce, 'home')
  const agentDir = join(home, 'agent')
  for (const path of [cwd, agentDir, join(root, 'history'), join(root, 'tmp')])
    mkdirSync(path, { recursive: true, mode: 0o700 })
  const provider = await startLoopbackModel().catch((error) => {
    rmSync(root, { recursive: true, force: true })
    throw error
  })
  const config: RpcBootstrapConfig = {
    schema: 1,
    nonce,
    sessionId: 'model-session',
    projectId: 'model-project',
    projectRoot: cwd,
    ompVersion: '18.10.3',
    contentHash: 'b'.repeat(64)
  }
  const metadata: RpcModelMetadata = {
    schema: 1,
    nonce,
    sessionId: config.sessionId,
    projectRoot: cwd,
    gatewayGeneration: 1,
    models: [
      {
        provider: providerName,
        id: 'unknown',
        name: 'Unknown limits',
        reasoning: false,
        input: ['text'],
        contextWindow: null,
        maxTokens: null
      },
      {
        provider: providerName,
        id: 'mixed-window',
        name: 'Unknown window',
        reasoning: false,
        input: ['text'],
        contextWindow: null,
        maxTokens: 1234
      },
      {
        provider: providerName,
        id: 'mixed-output',
        name: 'Unknown output',
        reasoning: false,
        input: ['text'],
        contextWindow: 65536,
        maxTokens: null
      },
      {
        provider: providerName,
        id: 'known',
        name: 'Known limits',
        reasoning: false,
        input: ['text'],
        contextWindow: 16384,
        maxTokens: 512
      }
    ]
  }
  const configPath = join(root, 'bootstrap.json')
  const metadataPath = join(agentDir, RPC_MODEL_METADATA_FILENAME)
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
  writeFileSync(metadataPath, JSON.stringify(metadata), { mode: 0o600 })
  writeFileSync(
    join(agentDir, 'models.yml'),
    JSON.stringify({
      providers: {
        [providerName]: {
          baseUrl: provider.url,
          transport: 'pi-native',
          api: 'openai-completions',
          apiKey: 'synthetic-private-gateway-bearer',
          models: metadata.models.map(
            ({ id, name, reasoning, input, contextWindow, maxTokens }) => ({
              id,
              name,
              reasoning,
              input,
              ...(contextWindow === null ? {} : { contextWindow }),
              ...(maxTokens === null ? {} : { maxTokens })
            })
          )
        }
      }
    }),
    { mode: 0o600 }
  )
  writeFileSync(
    join(agentDir, 'config.yml'),
    JSON.stringify({
      defaultProvider: providerName,
      defaultModel: 'unknown',
      compaction: { enabled: true },
      mcp: { enableProjectConfig: false },
      extensions: [],
      skills: [],
      memory: { enabled: false }
    }),
    { mode: 0o600 }
  )
  let stderr = ''
  let transport: RpcTransport | undefined
  let running = false
  const frames: RpcFrame[] = []
  const open = (): RpcTransport => {
    const child = spawn(
      resolveBunExecutable(),
      [
        '--preload',
        fileURLToPath(new URL('../engine-contract/network-guard.ts', import.meta.url)),
        fileURLToPath(new URL('../dist/cli.js', import.meta.resolve('@oh-my-pi/pi-coding-agent'))),
        '--mode',
        'rpc',
        '--provider',
        providerName,
        '--model',
        'unknown',
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
        )
      ],
      {
        cwd,
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_CACHE_HOME: join(home, '.cache'),
          XDG_DATA_HOME: join(home, '.local/share'),
          TMPDIR: join(root, 'tmp'),
          TMP: join(root, 'tmp'),
          TEMP: join(root, 'tmp'),
          PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: join(root, 'history'),
          PHI_RPC_CONFIG: configPath,
          NO_PROXY: '127.0.0.1,localhost',
          OMP_APP_NAME: 'Phi'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    running = true
    child.stderr.on('data', (bytes: Buffer) => {
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
  }
  const connection = new RpcConnection(open, {
    startupTimeoutMs: 15000,
    requestTimeoutMs: 10000,
    promptTimeoutMs: 15000
  })
  connection.onEvent((frame) => {
    frames.push(frame)
  })
  return {
    root,
    cwd,
    home,
    agentDir,
    configPath,
    metadataPath,
    config,
    metadata,
    connection,
    provider,
    frames,
    running: () => running,
    stderr: () => stderr,
    async close() {
      try {
        await connection.close()
      } finally {
        try {
          await transport?.close()
        } finally {
          try {
            await provider.close()
          } finally {
            rmSync(root, { recursive: true, force: true })
          }
        }
      }
    }
  }
}
