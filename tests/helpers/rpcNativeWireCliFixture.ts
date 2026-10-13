import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'

export async function nativeWireCli(
  base: string,
  baseline = false
): Promise<{
  connection: RpcConnection
  audit(): Promise<
    Array<{
      speculativeEnabled: boolean
      speculativeHostPresent: boolean
      toolExecutorsPresent: boolean
      originalContextLocalStatePresent: boolean
      tools: Array<Record<string, unknown>>
      messages: unknown[]
    }>
  >
  stderr(): string
  close(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'phi-native-wire-cli-'))
  for (const path of ['home', 'agent', 'project', 'tmp'])
    await mkdir(join(root, path), { mode: 0o700 })
  const audit = join(root, 'local-contract.jsonl'),
    scope = join(root, 'scope.json')
  await writeFile(
    scope,
    JSON.stringify({
      generation: 1,
      endpoint: base + '/v1/pi/stream',
      models: [{ provider: 'wire-fixture', id: 'wire-model' }]
    }),
    { mode: 0o600 }
  )
  await writeFile(
    join(root, 'agent/models.yml'),
    JSON.stringify({
      providers: {
        'wire-fixture': {
          api: 'openai-completions',
          baseUrl: base,
          transport: 'pi-native',
          apiKey: 'synthetic-wire-gateway-bearer',
          models: [
            {
              id: 'wire-model',
              name: 'Wire fixture',
              reasoning: false,
              input: ['text'],
              contextWindow: 65536,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    }),
    { mode: 0o600 }
  )
  await writeFile(
    join(root, 'agent/config.yml'),
    JSON.stringify({
      tools: { xdev: false, speculativeExecution: { enabled: true } },
      compaction: { enabled: false },
      memory: { enabled: false },
      mcp: { enableProjectConfig: false },
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
      '--model',
      'wire-fixture/wire-model',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--no-title',
      '--no-prewalk',
      '--no-lsp',
      '--no-pty',
      '--tools',
      'read,write,edit,bash',
      '--trusted-extension',
      fileURLToPath(new URL('./rpcNativeWireCli.ts', import.meta.url)),
      '--system-prompt',
      'Private native wire fixture'
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
        PHI_WIRE_SCOPE: scope,
        PHI_WIRE_LOCAL_AUDIT: audit,
        PHI_WIRE_ADAPTER: baseline
          ? resolve('.omx/t11c-wire-baseline/lib/rpc-native-stream-adapter.ts')
          : resolve('src/main/agent/engine/phi-extension/lib/rpc-native-stream-adapter.ts'),
        DO_NOT_TRACK: '1',
        NO_PROXY: '127.0.0.1,localhost'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  let stderr = '',
    closing: Promise<void> | undefined
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-32768)
  })
  const closed = new Promise<{ code: number | null; signal: string | null }>((complete, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => complete({ code, signal }))
  })
  const shutdown = (): Promise<void> =>
    (closing ??= (async () => {
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      try {
        const result = await closed
        if (result.code !== 0 || result.signal)
          throw new Error(`Wire CLI did not exit naturally: ${JSON.stringify(result)} ${stderr}`)
      } finally {
        clearTimeout(timer)
        await rm(root, { recursive: true, force: true })
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
  try {
    await connection.start()
  } catch (error) {
    await shutdown().catch(() => undefined)
    throw error
  }
  return {
    connection,
    audit: async () =>
      (await readFile(audit, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    stderr: () => stderr,
    close: () => connection.close()
  }
}
