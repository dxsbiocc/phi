import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import { OmpBridge, type OwnedModelGatewayLease } from '../../src/main/agent/engine/omp-bridge'
import { createModelGatewayCliFixture } from './model-gateway-cli-fixture'
import { startLoopbackCursor } from './loopbackCursor'

/** Real desktop Cursor provider -> production model gateway -> official RPC CLI/rpc-entry. */
export async function createRpcCursorFixture(): Promise<{
  provider: Awaited<ReturnType<typeof startLoopbackCursor>>
  cli: Awaited<ReturnType<typeof createModelGatewayCliFixture>>
  close(): Promise<void>
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-rpc-cursor-')))
  const agentDir = join(root, 'agent')
  for (const name of ['agent', 'home', 'tmp']) await mkdir(join(root, name), { mode: 0o700 })
  const provider = await startLoopbackCursor().catch(async (error) => {
    await rm(root, { recursive: true, force: true })
    throw error
  })
  const ref = { provider: 'cursor', id: 'cursor-grok-4.6-fast' }
  await writeFile(
    join(agentDir, 'models.yml'),
    JSON.stringify({
      providers: {
        cursor: {
          apiKey: 'synthetic-cursor-test-key',
          baseUrl: provider.url,
          modelOverrides: {
            [ref.id]: { baseUrl: provider.url, contextWindow: 32768, maxTokens: 256 }
          }
        }
      }
    }),
    { mode: 0o600 }
  )
  const bridge = new OmpBridge(() =>
    spawn(
      resolveBunExecutable(),
      [
        '--no-env-file',
        '--preload',
        fileURLToPath(new URL('../engine-contract/network-guard.ts', import.meta.url)),
        fileURLToPath(new URL('../../src/main/agent/engine/in-process/main.ts', import.meta.url))
      ],
      {
        cwd: root,
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: join(root, 'home'),
          XDG_CONFIG_HOME: join(root, 'home/.config'),
          XDG_DATA_HOME: join(root, 'home/.local/share'),
          XDG_CACHE_HOME: join(root, 'home/.cache'),
          PI_CODING_AGENT_DIR: agentDir,
          TMPDIR: join(root, 'tmp'),
          OMP_APP_NAME: 'Phi',
          NO_PROXY: '127.0.0.1,localhost'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
  )
  let lease: OwnedModelGatewayLease | undefined
  let cli: Awaited<ReturnType<typeof createModelGatewayCliFixture>> | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        await cli?.close()
      } finally {
        try {
          try {
            await lease?.close()
          } finally {
            await bridge.stop()
          }
        } finally {
          await provider.close()
          await rm(root, { recursive: true, force: true })
        }
      }
    })())
  try {
    lease = await bridge.createModelGatewayLease({
      sessionId: 'rpc-cursor-recovery',
      generation: 1,
      models: [ref]
    })
    cli = await createModelGatewayCliFixture(lease)
    return { provider, cli, close }
  } catch (error) {
    await close()
    throw error
  }
}
