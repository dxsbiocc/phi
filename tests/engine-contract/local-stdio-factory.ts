import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import type { RpcSessionTransportFactory } from '../../src/main/agent/engine/rpc/rpc-session-backend'
import type { RpcTransport } from '../../src/main/agent/engine/rpc/types'
import { startLoopbackModel } from './loopback-model'

/** Real CLI transport, constrained to disposable state and a scripted loopback provider. */
export async function createLocalStdioFixture(): Promise<{
  open: RpcSessionTransportFactory
  cwd: string
  agentDir: string
  provider: Awaited<ReturnType<typeof startLoopbackModel>>
  kill(sessionId: string): Promise<void>
  close(): Promise<void>
}> {
  const root = mkdtempSync(join(tmpdir(), 'phi-rpc-contract-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agents')
  for (const dir of [cwd, agentDir]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const transports = new Map<string, RpcTransport>()
  let nextSession = 0
  let closing: Promise<void> | undefined
  let provider: Awaited<ReturnType<typeof startLoopbackModel>>
  try {
    provider = await startLoopbackModel()
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
  const closeChild = async (
    child: ChildProcessWithoutNullStreams,
    closed: RpcTransport['closed']
  ): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
    try {
      await closed
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    cwd,
    agentDir,
    provider,
    open(params, signal) {
      if (signal.aborted) throw signal.reason ?? new Error('CLI startup aborted')
      const sessionRoot = join(agentDir, String(++nextSession))
      const home = join(sessionRoot, 'home')
      const privateAgentDir = join(sessionRoot, 'agent')
      const history = join(sessionRoot, 'history')
      const temp = join(sessionRoot, 'tmp')
      for (const dir of [home, privateAgentDir, history, temp])
        mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(privateAgentDir, 'models.yml'),
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
        join(privateAgentDir, 'config.yml'),
        JSON.stringify({
          defaultProvider: 'phi-contract',
          defaultModel: 'contract-model',
          compaction: { enabled: false },
          mcp: { enableProjectConfig: false },
          extensions: [],
          skills: [],
          memory: { enabled: false }
        }),
        { mode: 0o600 }
      )
      const child = spawn(
        resolveBunExecutable(),
        [
          '--preload',
          fileURLToPath(new URL('./network-guard.ts', import.meta.url)),
          fileURLToPath(
            new URL('../dist/cli.js', import.meta.resolve('@oh-my-pi/pi-coding-agent'))
          ),
          '--mode',
          'rpc',
          '--provider',
          'phi-contract',
          '--model',
          'contract-model',
          '--no-extensions',
          '--no-skills',
          '--no-rules',
          '--no-tools',
          '--no-title',
          '--no-prewalk',
          '--no-lsp',
          '--no-pty',
          '--no-ui',
          '--system-prompt',
          'Answer the user using only the supplied conversation.'
        ],
        {
          cwd: params.cwd,
          env: {
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: join(home, '.config'),
            XDG_CACHE_HOME: join(home, '.cache'),
            XDG_DATA_HOME: join(home, '.local/share'),
            TMPDIR: temp,
            TMP: temp,
            TEMP: temp,
            PI_CODING_AGENT_DIR: privateAgentDir,
            PI_CODING_AGENT_SESSION_DIR: history,
            NO_PROXY: '127.0.0.1,localhost',
            OMP_APP_NAME: 'Phi'
          },
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
      const closed = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }))
        }
      )
      // Startup and teardown can race; the returned close remains idempotent.
      let childClosing: Promise<void> | undefined
      const transport: RpcTransport = {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        closed,
        close: () => (childClosing ??= closeChild(child, closed))
      }
      transports.set(params.sessionId, transport)
      return transport
    },
    async kill(sessionId) {
      await transports.get(sessionId)?.close()
    },
    close() {
      closing ??= (async () => {
        try {
          await Promise.all([...transports.values()].map((transport) => transport.close()))
        } finally {
          try {
            await provider.close()
          } finally {
            rmSync(root, { recursive: true, force: true })
          }
        }
      })()
      return closing
    }
  }
}
