import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import {
  RPC_BOOTSTRAP_OMP_VERSION,
  type RpcBootstrapConfig
} from '../../src/main/agent/engine/phi-extension/lib/rpc-config'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type { RpcFrame, RpcTransport } from '../../src/main/agent/engine/rpc/types'
import { startLoopbackModel } from './loopback-model'

interface BootstrapStdioFixture {
  root: string
  cwd: string
  home: string
  agentDir: string
  configPath: string
  expected: RpcBootstrapConfig
  connection: RpcConnection
  open(): RpcTransport
  provider: Awaited<ReturnType<typeof startLoopbackModel>>
  frames: RpcFrame[]
  stderr(): string
  running(): boolean
  close(): Promise<void>
}

/** A real CLI with only disposable state and a loopback provider, never desktop credentials. */
export async function createBootstrapFixture(
  options: {
    config?: (valid: RpcBootstrapConfig) => unknown
    missingConfig?: boolean
    missingEntry?: boolean
    configMode?: number
  } = {}
): Promise<BootstrapStdioFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-rpc-bootstrap-')))
  const cwd = join(root, 'project')
  const home = join(root, 'home')
  const agentDir = join(root, 'agent')
  for (const dir of [cwd, home, agentDir, join(root, 'history'), join(root, 'tmp')])
    mkdirSync(dir, { mode: 0o700 })
  const provider = await startLoopbackModel().catch((error) => {
    rmSync(root, { recursive: true, force: true })
    throw error
  })
  const expected: RpcBootstrapConfig = {
    schema: 1,
    nonce: randomUUID(),
    sessionId: 'bootstrap-session',
    projectId: 'bootstrap-project',
    projectRoot: cwd,
    ompVersion: RPC_BOOTSTRAP_OMP_VERSION,
    contentHash: 'a'.repeat(64)
  }
  const configPath = join(root, 'bootstrap.json')
  if (!options.missingConfig)
    writeFileSync(configPath, JSON.stringify(options.config?.(expected) ?? expected), {
      mode: options.configMode ?? 0o600
    })
  if (!options.missingConfig && options.configMode !== undefined)
    chmodSync(configPath, options.configMode)
  writeFileSync(
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
  writeFileSync(
    join(agentDir, 'config.yml'),
    JSON.stringify({
      defaultProvider: 'phi-contract',
      defaultModel: 'contract-model',
      compaction: { enabled: false },
      edit: { mode: 'replace' },
      mcp: { enableProjectConfig: false },
      extensions: [],
      skills: [],
      memory: { enabled: false }
    }),
    { mode: 0o600 }
  )
  const frames: RpcFrame[] = []
  let stderr = ''
  let transport: RpcTransport | undefined
  let running = false
  const open = (): RpcTransport => {
    const child = spawn(
      resolveBunExecutable(),
      [
        '--preload',
        fileURLToPath(new URL('./network-guard.ts', import.meta.url)),
        fileURLToPath(new URL('../dist/cli.js', import.meta.resolve('@oh-my-pi/pi-coding-agent'))),
        '--mode',
        'rpc',
        '--provider',
        'phi-contract',
        '--model',
        'contract-model',
        '--no-extensions',
        '--no-skills',
        '--no-rules',
        '--no-title',
        '--no-prewalk',
        '--no-lsp',
        '--no-pty',
        '--tools',
        'read,write,edit,bash,glob,grep',
        '-e',
        options.missingEntry
          ? join(root, 'missing-entry.ts')
          : fileURLToPath(
              new URL('../../src/main/agent/engine/phi-extension/rpc-entry.ts', import.meta.url)
            ),
        '--system-prompt',
        'Follow the scripted user request. Use only the requested tool.'
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
          const deadline = setTimeout(() => child.kill('SIGKILL'), 2000)
          try {
            await closed
          } finally {
            clearTimeout(deadline)
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
    expected,
    connection,
    open,
    provider,
    frames,
    stderr: () => stderr,
    running: () => running,
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
