import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import type {
  CreateModelGatewayLeaseParams,
  ModelGatewayLease
} from '../../src/main/agent/engine/model-gateway-types'
import { startHostResultModel, type ModelReply } from './rpcHostResultModel'
import { startVendorProvider } from './model-gateway-vendor-provider'

export const RPC_COMPOSITION_REF = { provider: 'phi-composition', id: 'composition-model' } as const
export interface CompositionGateway {
  readonly ref: { readonly provider: string; readonly id: string }
  create(params: CreateModelGatewayLeaseParams): Promise<ModelGatewayLease>
  revoke(leaseId: string): Promise<void>
  enqueue(...replies: ModelReply[]): Promise<void>
  snapshot(): Promise<{
    gateway: { leases: number; activeRequests: number }
    providerRequests: Array<{ body: Record<string, unknown> }>
  }>
  close(): Promise<void>
}
/** Real SDK image-capable registry in a disposable Bun process. The Node peer is only a scripted vendor. */
export async function startCompositionGateway(
  anthropic = false,
  contextWindow = 32768
): Promise<CompositionGateway> {
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 32768 || contextWindow > 2_000_000)
    throw new Error('Invalid private composition model window')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-composition-gateway-')))
  for (const name of ['home', 'agent', 'tmp']) await mkdir(join(root, name), { mode: 0o700 })
  const ordinary = anthropic ? undefined : await startHostResultModel()
  const vendor = anthropic ? await startVendorProvider() : undefined
  const provider = ordinary ?? vendor!
  const child = spawn(
    resolveBunExecutable(),
    [
      '--no-env-file',
      fileURLToPath(new URL('./rpcRuntimeCompositionGatewayChild.ts', import.meta.url))
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        PI_CODING_AGENT_DIR: join(root, 'agent'),
        TMPDIR: join(root, 'tmp'),
        XDG_DATA_HOME: join(root, 'home/.local/share'),
        XDG_CACHE_HOME: join(root, 'home/.cache'),
        PHI_COMPOSITION_PROVIDER: provider.url,
        PHI_COMPOSITION_ANTHROPIC: anthropic ? '1' : '',
        PHI_COMPOSITION_CONTEXT_WINDOW: String(contextWindow),
        PI_PROXY_ANTHROPIC: anthropic ? provider.url : ''
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let sequence = 0,
    stderr = '',
    ended = false
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-32768)
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const response = JSON.parse(line)
    const entry = pending.get(response.id)
    if (!entry) return
    pending.delete(response.id)
    clearTimeout(entry.timer)
    if (response.ok) entry.resolve(response.result)
    else entry.reject(new Error('Private composition gateway command failed'))
  })
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => {
      ended = true
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`Private composition gateway exited: ${stderr}`))
      }
      pending.clear()
      resolve(code)
    })
  )
  const command = <T>(method: string, params?: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Private composition gateway deadline'))
        child.kill()
      }, 15_000)
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        if (!ended) await command('close')
        child.stdin.end()
        const code = await exited
        if (code !== 0)
          throw new Error(`Private composition gateway did not exit naturally: ${stderr}`)
      } finally {
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
    create: (params: CreateModelGatewayLeaseParams) => command<ModelGatewayLease>('create', params),
    revoke: (leaseId: string) => command<void>('revoke', { leaseId }),
    ref: anthropic ? { provider: 'anthropic', id: 'claude-sonnet-4-6' } : RPC_COMPOSITION_REF,
    enqueue: async (...replies: ModelReply[]) => {
      if (ordinary) ordinary.enqueue(...replies)
      else {
        if (replies.some((reply) => reply.tool))
          throw new Error('Anthropic composition fixture does not script tool calls')
        vendor!.enqueue(...replies.map(({ text, hold }) => ({ text, hold })))
      }
    },
    snapshot: async () => ({
      gateway: await command<{ leases: number; activeRequests: number }>('snapshot'),
      providerRequests: ordinary
        ? ordinary.requests.map((body) => ({ body }))
        : vendor!.requests.map(({ body }) => ({ body }))
    }),
    close
  }
}
