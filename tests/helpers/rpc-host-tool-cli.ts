import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type { RpcFrame, RpcTransport } from '../../src/main/agent/engine/rpc/types'
import { startLoopbackModel } from '../engine-contract/loopback-model'

/** Protocol oracle only: no production Phi extension or claim of main-origin attestation. */
export async function hostToolCli(): Promise<{
  connection: RpcConnection
  provider: Awaited<ReturnType<typeof startLoopbackModel>>
  frames: RpcFrame[]
  cwd: string
  running(): boolean
  stderr(): string
  close(): Promise<void>
}> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-host-tool-cli-')))
  const cwd = join(root, 'project')
  const home = join(root, 'home')
  const agentDir = join(root, 'agent')
  const temporary = join(root, 'tmp')
  const history = join(root, 'history')
  for (const dir of [cwd, home, agentDir, temporary, history]) mkdirSync(dir, { mode: 0o700 })
  const provider = await startLoopbackModel().catch((error) => {
    rmSync(root, { recursive: true, force: true })
    throw error
  })
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
              input: ['text', 'image'],
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
  const configPath = join(root, 'startup-policy.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultProvider: 'phi-contract',
      defaultModel: 'contract-model',
      compaction: { enabled: false },
      mcp: { enableProjectConfig: false },
      extensions: [],
      skills: [],
      lsp: { enabled: false },
      memory: { enabled: false }
    }),
    { mode: 0o600 }
  )
  let transport: RpcTransport | undefined
  let running = false
  let stderr = ''
  const frames: RpcFrame[] = []
  const connection = new RpcConnection(
    () => {
      const child = spawn(
        resolveBunExecutable(),
        [
          '--preload',
          fileURLToPath(new URL('../engine-contract/network-guard.ts', import.meta.url)),
          fileURLToPath(
            new URL('../dist/cli.js', import.meta.resolve('@oh-my-pi/pi-coding-agent'))
          ),
          '--mode',
          'rpc',
          '--provider',
          'phi-contract',
          '--model',
          'contract-model',
          '--config',
          configPath,
          '--no-extensions',
          '--no-skills',
          '--no-rules',
          '--no-tools',
          '--no-title',
          '--no-prewalk',
          '--no-lsp',
          '--no-pty',
          '--no-ui',
          '--no-session',
          '--system-prompt',
          'Use only the tool requested by the scripted synthetic user.'
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
            TMPDIR: temporary,
            TMP: temporary,
            TEMP: temporary,
            PI_CODING_AGENT_DIR: agentDir,
            PI_CODING_AGENT_SESSION_DIR: history,
            NO_PROXY: '127.0.0.1,localhost',
            OMP_APP_NAME: 'Phi'
          },
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
      running = true
      child.stderr.on('data', (bytes: Buffer) => {
        stderr = (stderr + bytes.toString()).slice(-65536)
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
        close() {
          return (closing ??= (async () => {
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
      }
      return transport
    },
    { startupTimeoutMs: 15000, requestTimeoutMs: 10000, promptTimeoutMs: 15000 }
  )
  connection.onEvent((frame) => frames.push(frame))
  return {
    connection,
    provider,
    frames,
    cwd,
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
