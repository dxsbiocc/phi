import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import type {
  ModelGatewayLease,
  ModelGatewayModelRef
} from '../../src/main/agent/engine/model-gateway-types'
import { createPhiExtensionBundle } from '../../src/main/agent/engine/rpc/extension-deployment/bundle'
import { attestBootstrap } from '../../src/main/agent/engine/rpc/bootstrap-attestation'
import { selectRemoteModel } from '../../src/main/agent/engine/rpc/model-selection'
import { writeRemoteModelProxyConfig } from '../../src/main/agent/engine/rpc/model-proxy-config'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type { RpcTransport } from '../../src/main/agent/engine/rpc/types'
import { createModelProxyConfigFixture } from './modelProxyConfigFixture'

/** B's real private writer and E/C's verified selection, with an actual official CLI. */
export async function createModelGatewayCliFixture(lease: ModelGatewayLease): Promise<{
  connection: RpcConnection
  select(model: ModelGatewayModelRef): Promise<void>
  stderr(): string
  audit(): Promise<unknown[]>
  close(): Promise<void>
}> {
  const local = await createModelProxyConfigFixture()
  const publication = await writeRemoteModelProxyConfig({
    session: local.session,
    startup: local.startup,
    agentDir: local.agentDir,
    models: lease.models,
    remotePort: lease.localPort,
    gatewayBearer: lease.bearerToken,
    sessionId: lease.sessionId,
    projectRoot: local.projectRoot,
    gatewayGeneration: lease.generation
  })
  const sourceRoot = fileURLToPath(
    new URL('../../src/main/agent/engine/phi-extension', import.meta.url)
  )
  const bundle = await createPhiExtensionBundle(sourceRoot)
  const home = dirname(local.agentDir)
  for (const path of [join(home, 'history'), join(home, 'tmp')]) await mkdir(path, { mode: 0o700 })
  const config = {
    schema: 1 as const,
    nonce: publication.nonce,
    sessionId: lease.sessionId,
    projectId: 'private-gateway-cli-project',
    projectRoot: local.projectRoot,
    ompVersion: '18.10.3' as const,
    contentHash: bundle.contentHash
  }
  const auditPath = join(home, 'wire-shape.jsonl')
  const configPath = join(home, 'bootstrap.json')
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  await writeFile(
    join(local.agentDir, 'config.yml'),
    JSON.stringify({
      compaction: { enabled: false },
      mcp: { enableProjectConfig: false },
      extensions: [],
      skills: [],
      memory: { enabled: false }
    }),
    { mode: 0o600 }
  )
  const first = lease.models[0]
  let stderr = ''
  let transport: RpcTransport | undefined
  const connection = new RpcConnection(
    () => {
      const child = spawn(
        resolveBunExecutable(),
        [
          '--preload',
          fileURLToPath(new URL('./model-gateway-cli-preload.ts', import.meta.url)),
          fileURLToPath(
            new URL('../dist/cli.js', import.meta.resolve('@oh-my-pi/pi-coding-agent'))
          ),
          '--mode',
          'rpc',
          '--provider',
          first.provider,
          '--model',
          first.id,
          '--no-extensions',
          '--no-skills',
          '--no-rules',
          '--no-title',
          '--no-prewalk',
          '--no-lsp',
          '--no-pty',
          '--no-tools',
          '--trusted-extension',
          join(sourceRoot, bundle.entryPoint),
          '--system-prompt',
          'Use the requested model and preserve the conversation.'
        ],
        {
          cwd: local.projectRoot,
          env: {
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: join(home, '.config'),
            XDG_CACHE_HOME: join(home, '.cache'),
            XDG_DATA_HOME: join(home, '.local/share'),
            TMPDIR: join(home, 'tmp'),
            TMP: join(home, 'tmp'),
            TEMP: join(home, 'tmp'),
            PI_CODING_AGENT_DIR: local.agentDir,
            PI_CODING_AGENT_SESSION_DIR: join(home, 'history'),
            PHI_RPC_CONFIG: configPath,
            PHI_GATEWAY_CLI_WIRE_AUDIT: auditPath,
            PHI_GATEWAY_CLI_EXPECTED_BEARER: lease.bearerToken,
            NO_PROXY: '127.0.0.1,localhost',
            OMP_APP_NAME: 'Phi'
          },
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
      child.stderr.on('data', (bytes: Buffer) => {
        stderr = (stderr + bytes.toString()).slice(-32768)
      })
      const closed = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
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
    { startupTimeoutMs: 15000, requestTimeoutMs: 10000, promptTimeoutMs: 30000 }
  )
  let closing: Promise<void> | undefined
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        await connection.close()
      } finally {
        try {
          await transport?.close()
        } finally {
          await local.cleanup()
        }
      }
    })())
  const expected = { schema: 1 as const, ...publication, models: lease.models }
  const select = (model: ModelGatewayModelRef): Promise<void> =>
    selectRemoteModel(connection, expected, model, new AbortController().signal)
  try {
    await connection.start()
    await attestBootstrap(connection, config, new AbortController().signal)
    await select(first)
    return {
      connection,
      select,
      stderr: () => stderr,
      audit: async () =>
        (await readFile(auditPath, 'utf8').catch(() => ''))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown),
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}
