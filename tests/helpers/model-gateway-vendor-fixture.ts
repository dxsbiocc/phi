import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import type { ModelGatewayLease } from '../../src/main/agent/engine/model-gateway-types'
import {
  startVendorProvider,
  type VendorKind,
  type VendorReply
} from './model-gateway-vendor-provider'

export interface VendorTurn {
  message: Record<string, unknown>
  events: Array<Record<string, unknown>>
  cancellation: boolean
}
export interface VendorSnapshot {
  refreshes: number
  redirectedOrigins: string[]
  wire: Array<{
    credentialInBody: boolean
    credentialInHeader: boolean
    responseHeaders: Record<string, string>
    redactedOnWire: boolean
    rawErrorLeak: boolean
  }>
  gateway: { leases: number; activeRequests: number }
  websocketEnv: string
  originalCodexPreference: boolean
  debugEnabled: boolean
  logLeaks: boolean
  logFiles: number
}

export async function startVendorFixture(): Promise<{
  create(kind: VendorKind): Promise<ModelGatewayLease>
  turn(kind: VendorKind, hop: boolean, context: unknown, cancel?: boolean): Promise<VendorTurn>
  enqueue(...replies: VendorReply[]): void
  provider: Awaited<ReturnType<typeof startVendorProvider>>
  snapshot(): Promise<VendorSnapshot>
  stderr(): string
  close(): Promise<void>
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-vendor-parity-')))
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  const agent = join(root, 'agent')
  for (const path of [home, cwd, agent, join(root, 'tmp')]) await mkdir(path, { mode: 0o700 })
  const provider = await startVendorProvider().catch(async (error) => {
    await rm(root, { recursive: true, force: true })
    throw error
  })
  const child = spawn(
    resolveBunExecutable(),
    [fileURLToPath(new URL('./model-gateway-vendor-child.ts', import.meta.url))],
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
        PHI_VENDOR_ROOT: root,
        PHI_VENDOR_URL: provider.url,
        PI_CODEX_WEBSOCKET: '1',
        PI_PROXY_ANTHROPIC: provider.url,
        PI_REQ_DEBUG: '1',
        OMP_AUTH_BROKER_URL: '',
        OMP_AUTH_BROKER_TOKEN: ''
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  let sequence = 0
  let stderr = ''
  let buffer = ''
  let ended = false
  let closing: Promise<void> | undefined
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >()
  const fail = (error: Error): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-32768)
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
      fail(new Error('Private protocol response exceeds bound'))
      child.kill()
      return
    }
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        const frame = JSON.parse(line) as {
          id: string
          ok: boolean
          result?: unknown
          error?: string
        }
        const entry = pending.get(frame.id)
        if (!entry || typeof frame.ok !== 'boolean')
          throw new Error('Unexpected private protocol frame')
        pending.delete(frame.id)
        clearTimeout(entry.timer)
        if (frame.ok) entry.resolve(frame.result)
        else entry.reject(new Error(frame.error ?? 'Private vendor command failed'))
      } catch {
        fail(new Error('Invalid private protocol frame'))
        child.kill()
      }
    }
  })
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => {
      ended = true
      fail(new Error(`Vendor child exited (${code}): ${stderr}`))
      resolve(code)
    })
  )
  child.once('error', fail)
  const command = <T>(method: string, params?: unknown): Promise<T> => {
    if (ended) return Promise.reject(new Error(`Vendor child already exited: ${stderr}`))
    const id = String(++sequence)
    const line = JSON.stringify({ id, method, params }) + '\n'
    if (Buffer.byteLength(line) > 4 * 1024 * 1024)
      return Promise.reject(new Error('Private command exceeds bound'))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Vendor ${method} timed out: ${stderr}`))
        child.kill()
      }, 15000)
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      child.stdin.write(line, (error) => {
        if (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(error)
        }
      })
    })
  }
  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        if (!ended) await command('close')
        child.stdin.end()
        const timer = setTimeout(() => child.kill(), 5000)
        const code = await exited
        clearTimeout(timer)
        if (code !== 0) throw new Error(`Vendor child did not exit naturally (${code}): ${stderr}`)
      } catch (error) {
        child.kill()
        await exited
        throw error
      } finally {
        await provider.close()
        await rm(root, { recursive: true, force: true })
      }
    })()
    return closing
  }
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
    create: (kind) => command('create', { kind }),
    turn: (kind, hop, context, cancel) => command('turn', { kind, hop, context, cancel }),
    enqueue: (...replies) => provider.enqueue(...replies),
    provider,
    snapshot: () => command('snapshot'),
    stderr: () => stderr,
    close
  }
}
