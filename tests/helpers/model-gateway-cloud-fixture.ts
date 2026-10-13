import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import {
  startCloudProvider,
  CLOUD_SECRETS as secrets,
  type CloudCategory
} from './model-gateway-cloud-provider'

export interface CloudMessage {
  role: 'assistant'
  api: string
  provider: string
  model: string
  timestamp: number
  stopReason: string
  content: Array<{
    type: string
    text?: string
    thinking?: string
    thinkingSignature?: string
    id?: string
    name?: string
    arguments?: Record<string, unknown>
  }>
  usage: Record<string, unknown>
  errorMessage?: string
}
export interface CloudTurn {
  message: CloudMessage
  events: Array<{ type: string }>
  lease?: { models: unknown[] }
}
export interface CloudSnapshot {
  available: Array<{ provider: string; id: string }>
  mappedRequests: Array<{ url: string; headers: Record<string, string>; body: string }>
  gateway: { leases: number; activeRequests: number }
  customCalls: number
  customAborts: number
  logs: string[]
}
export interface CloudFixture {
  root: string
  provider: Awaited<ReturnType<typeof startCloudProvider>>
  stderr(): string
  hostBridgeCalls(): number
  snapshot(): Promise<CloudSnapshot>
  turn(category: CloudCategory, native: boolean, context: unknown, id?: string): Promise<CloudTurn>
  abort(id: string): Promise<unknown>
  close(): Promise<void>
}
export async function startCloudFixture(): Promise<CloudFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-cloud-parity-'))),
    home = join(root, 'home'),
    agent = join(root, 'agent'),
    cwd = join(root, 'project')
  for (const directory of [home, agent, cwd, join(root, 'tmp')])
    await mkdir(directory, { mode: 0o700 })
  const adc = join(root, 'private-adc.json')
  await writeFile(
    adc,
    JSON.stringify({
      type: 'authorized_user',
      client_id: secrets.adcClient,
      client_secret: secrets.adcSecret,
      refresh_token: secrets.adcRefresh
    }),
    { mode: 0o600 }
  )
  const provider = await startCloudProvider().catch(async (error) => {
    await rm(root, { recursive: true, force: true })
    throw error
  })
  const child = spawn(
    resolveBunExecutable(),
    [fileURLToPath(new URL('./model-gateway-cloud-child.ts', import.meta.url))],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: join(root, 'tmp'),
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_CACHE_HOME: join(home, '.cache'),
        XDG_DATA_HOME: join(home, '.local/share'),
        PI_CODING_AGENT_DIR: agent,
        PHI_CLOUD_ROOT: root,
        PHI_CLOUD_BASE: provider.url,
        AWS_ACCESS_KEY_ID: secrets.awsId,
        AWS_SECRET_ACCESS_KEY: secrets.awsSecret,
        AWS_SESSION_TOKEN: secrets.awsToken,
        AWS_REGION: 'us-west-2',
        AWS_EC2_METADATA_DISABLED: 'true',
        GOOGLE_APPLICATION_CREDENTIALS: adc,
        GOOGLE_CLOUD_PROJECT: 'private-vertex-project',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
        OMP_AUTH_BROKER_URL: '',
        OMP_AUTH_BROKER_TOKEN: ''
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  let stderr = '',
    sequence = 0,
    closed = false,
    hostBridgeCalls = 0
  child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-32768)))
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >()
  const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
  const fail = (error: Error): void => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    pending.clear()
  }
  child.once('error', fail)
  child.once('exit', (code) => {
    closed = true
    fail(new Error(`Cloud child exited (${code}): ${stderr}`))
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const reply = JSON.parse(line) as {
      type?: string
      id: string
      method?: string
      ok: boolean
      result: unknown
      error: string
    }
    if (reply.type === 'hostRequest') {
      if (reply.method !== 'cursorBridge.ensure') {
        fail(new Error('Unexpected cloud host method'))
        child.kill()
        return
      }
      hostBridgeCalls++
      void provider.bridge
        .ensure()
        .then((baseUrl) =>
          child.stdin.write(
            JSON.stringify({ type: 'hostResponse', id: reply.id, ok: true, result: { baseUrl } }) +
              '\n'
          )
        )
      return
    }
    const item = pending.get(reply.id)
    if (!item) {
      fail(new Error('Unexpected cloud fixture frame'))
      child.kill()
      return
    }
    pending.delete(reply.id)
    clearTimeout(item.timer)
    if (reply.ok) item.resolve(reply.result)
    else item.reject(new Error(reply.error))
  })
  const command = <T>(method: string, params?: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error(`Cloud fixture closed: ${stderr}`))
        return
      }
      const id = String(++sequence),
        timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Cloud fixture ${method} timed out: ${stderr}`))
          child.kill()
        }, 15000)
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      })
    })
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> =>
    (closePromise ??= (async () => {
      try {
        if (!closed) await command('close')
        child.stdin.end()
        const timer = setTimeout(() => child.kill(), 5000),
          code = await exited
        clearTimeout(timer)
        if (code !== 0) throw new Error(`Cloud fixture did not exit naturally (${code}): ${stderr}`)
      } finally {
        if (!closed) child.kill()
        await exited
        lines.close()
        await provider.close()
        await rm(root, { recursive: true, force: true })
      }
    })())
  try {
    await command('snapshot')
  } catch (error) {
    child.kill()
    await exited
    await provider.close()
    await rm(root, { recursive: true, force: true })
    throw error
  }
  return {
    root,
    provider,
    stderr: () => stderr,
    hostBridgeCalls: () => hostBridgeCalls,
    snapshot: () => command<CloudSnapshot>('snapshot'),
    turn: (category: CloudCategory, native: boolean, context: unknown, id = `turn-${++sequence}`) =>
      command<CloudTurn>('turn', { category, native, context, id }),
    abort: (id: string) => command('abort', id),
    close
  }
}
