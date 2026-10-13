import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'

export const NATIVE_CLI_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5'] as const
export async function startNativeStreamCli(
  root: string,
  base: string,
  sessionPath?: string
): Promise<{
  connection: RpcConnection
  status(command?: string): Promise<Record<string, unknown>>
  notifications: Array<Record<string, unknown>>
  stderr(): string
  close(): Promise<void>
}> {
  for (const dir of ['home', 'agent', 'project', 'tmp', 'history'])
    await mkdir(join(root, dir), { recursive: true, mode: 0o700 })
  const scopePath = join(root, 'scope.json')
  await writeFile(
    scopePath,
    JSON.stringify({
      generation: 1,
      endpoint: base + '/v1/pi/stream',
      models: NATIVE_CLI_MODELS.map((id) => ({ provider: 'anthropic', id }))
    }),
    { mode: 0o600 }
  )
  await writeFile(
    join(root, 'agent', 'models.yml'),
    JSON.stringify({
      providers: {
        anthropic: {
          api: 'openai-completions',
          baseUrl: base,
          transport: 'pi-native',
          apiKey: 'synthetic-gateway-bearer',
          models: NATIVE_CLI_MODELS.map((id) => ({
            id,
            name: id,
            reasoning: true,
            input: ['text'],
            contextWindow: 200000,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }))
        }
      }
    }),
    { mode: 0o600 }
  )
  await writeFile(
    join(root, 'agent', 'config.yml'),
    JSON.stringify({
      compaction: { enabled: false },
      mcp: { enableProjectConfig: false },
      memory: { enabled: false },
      extensions: [],
      skills: []
    }),
    { mode: 0o600 }
  )
  const child = spawn(
    resolveBunExecutable(),
    [
      '--no-env-file',
      '--preload',
      fileURLToPath(new URL('../engine-contract/network-guard.ts', import.meta.url)),
      fileURLToPath(new URL('../dist/cli.js', import.meta.resolve('@oh-my-pi/pi-coding-agent'))),
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
      '--model',
      'anthropic/' + NATIVE_CLI_MODELS[0],
      '--trusted-extension',
      fileURLToPath(new URL('./rpcNativeStreamCli.ts', import.meta.url)),
      '--system-prompt',
      'Private native stream fixture',
      ...(sessionPath ? ['--session', sessionPath] : [])
    ],
    {
      cwd: join(root, 'project'),
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: join(root, 'home'),
        USERPROFILE: join(root, 'home'),
        TMPDIR: join(root, 'tmp'),
        XDG_CONFIG_HOME: join(root, 'home/.config'),
        XDG_CACHE_HOME: join(root, 'home/.cache'),
        XDG_DATA_HOME: join(root, 'home/.local/share'),
        PI_CODING_AGENT_DIR: join(root, 'agent'),
        PI_CODING_AGENT_SESSION_DIR: join(root, 'history'),
        PHI_NATIVE_FIXTURE_SCOPE: scopePath,
        NO_PROXY: '127.0.0.1,localhost',
        DO_NOT_TRACK: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  let stderr = '',
    closing: Promise<void> | undefined,
    sequence = 0
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-32768)
  })
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const shutdown = (): Promise<void> =>
    (closing ??= (async () => {
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      try {
        const result = await closed
        if (result.code !== 0 || result.signal)
          throw new Error(
            `Native CLI failed natural EOF cleanup: ${JSON.stringify(result)} ${stderr}`
          )
      } finally {
        clearTimeout(timer)
      }
    })())
  const connection = new RpcConnection(
    async () => ({
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      closed,
      close: shutdown
    }),
    { startupTimeoutMs: 15000, requestTimeoutMs: 10000, promptTimeoutMs: 15000 }
  )
  const notifications: Array<Record<string, unknown>> = []
  connection.onEvent((frame) => {
    if (frame.type === 'extension_ui_request' && typeof frame.message === 'string') {
      const value: unknown = JSON.parse(frame.message)
      if (
        value &&
        typeof value === 'object' &&
        String((value as Record<string, unknown>).type).startsWith('native_fixture_')
      ) {
        if (notifications.length >= 128) throw new Error('Private notification bound exceeded')
        notifications.push(value as Record<string, unknown>)
      }
    }
  })
  try {
    await connection.start()
  } catch (error) {
    await shutdown().catch(() => undefined)
    throw error
  }
  return {
    connection,
    notifications,
    status: async (command = 'phi-native-status') => {
      const nonce = 'private-' + ++sequence
      await connection.prompt('/' + command + ' ' + nonce)
      const deadline = Date.now() + 1000
      while (!notifications.some((item) => item.nonce === nonce) && Date.now() < deadline)
        await delay(10)
      const found = notifications.find((item) => item.nonce === nonce)
      if (!found) throw new Error(`Native CLI notification unavailable: ${stderr}`)
      return found
    },
    stderr: () => stderr,
    close: () => connection.close()
  }
}
