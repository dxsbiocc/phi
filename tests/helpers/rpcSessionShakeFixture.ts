import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import { createRpcSessionVerifier } from '../../src/main/agent/engine/rpc/session-verification'
import type { RpcFrame, RpcTransport } from '../../src/main/agent/engine/rpc/types'
import { createSessionVerificationFixture } from './rpcSessionVerificationFixture'

/** Reuse the private layout/model setup; old frozen fixture/source remains unchanged. */
export async function createSessionShakeFixture(): Promise<
  Awaited<ReturnType<typeof createSessionVerificationFixture>> & {
    create(kind?: 'long-line'): Promise<Record<string, unknown>>
  }
> {
  const base = await createSessionVerificationFixture()
  await base.connection.close()
  const home = join(base.root, 'home'),
    agent = join(home, '.omp/agent'),
    configPath = join(agent, 'config.yml')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  // Enable the SDK defaults. No threshold/protect/minSavings is lowered.
  config.compaction = { enabled: true }
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  const frames: RpcFrame[] = []
  let stderr = '',
    transport: RpcTransport | undefined,
    running = false
  const connection = new RpcConnection(
    () => {
      const child = spawn(
        '/bin/sh',
        [
          '-c',
          'umask 077; exec "$@"',
          'phi-shake-oracle',
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
          base.identity.journals,
          '--no-extensions',
          '--no-skills',
          '--no-rules',
          '--no-tools',
          '--no-title',
          '--no-prewalk',
          '--no-lsp',
          '--no-pty',
          '--trusted-extension',
          fileURLToPath(new URL('./rpcSessionShakeExtension.ts', import.meta.url))
        ],
        {
          cwd: base.identity.projectRoot,
          env: {
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            HOME: home,
            USERPROFILE: home,
            PI_CODING_AGENT_DIR: agent,
            XDG_DATA_HOME: join(base.identity.directory, 'data'),
            XDG_CONFIG_HOME: join(home, '.config'),
            XDG_CACHE_HOME: join(base.root, 'cache'),
            XDG_STATE_HOME: join(base.root, 'state'),
            TMPDIR: join(base.root, 'tmp'),
            TMP: join(base.root, 'tmp'),
            TEMP: join(base.root, 'tmp'),
            PHI_VERIFIER_FIXTURE: join(base.root, 'capability.json')
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
  const command = async (command: string): Promise<Record<string, unknown> | undefined> => {
    const offset = frames.length,
      result = await connection.prompt('/phi-shake-oracle ' + command)
    assert.equal(result.agentInvoked, false)
    assert.equal(result.status, 'completed', JSON.stringify({ result, stderr }))
    for (const frame of frames.slice(offset))
      if (frame.type === 'extension_ui_request' && typeof frame.message === 'string') {
        const value = JSON.parse(frame.message)
        if (String(value.type).startsWith('shake_')) return value
      }
    return undefined
  }
  try {
    await connection.start()
  } catch (error) {
    await transport?.close()
    await base.close()
    throw error
  }
  return {
    root: base.root,
    identity: base.identity,
    reference: base.reference,
    bytes: base.bytes,
    connection,
    frames,
    fixtureCommand: command,
    stderr: () => stderr,
    running: () => running,
    get verifier() {
      return createRpcSessionVerifier({
        connection,
        control: connection.bindControl(),
        identity: base.identity,
        assertActive: () => undefined
      })
    },
    async create(kind) {
      return (await command(kind === 'long-line' ? 'create-long-line' : 'create'))!
    },
    async close() {
      try {
        if (running) assert.equal((await command('stats'))?.providerCalls, 0)
      } finally {
        try {
          await connection.close()
          await transport?.close()
        } finally {
          await base.close()
        }
      }
    }
  }
}
