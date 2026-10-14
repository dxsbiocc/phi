import { createServer, connect, type Socket } from 'node:net'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { shellQuote } from '../../src/main/agent/wrappers/remote-ssh-session'
import type { AddressInfo } from 'node:net'
import { createPhiExtensionBundle } from '../../src/main/agent/engine/rpc/extension-deployment'
import {
  RemoteSessionRuntime,
  type RemoteRuntimeSnapshot,
  type RemoteSessionRuntimeOptions
} from '../../src/main/agent/engine/rpc/remote-session-runtime'
import type { OwnedModelGatewayLease } from '../../src/main/agent/engine/omp-bridge'
import type { RemoteReverseTunnel } from '../../src/main/agent/wrappers/remote-ssh-session'
import { createPersistentLauncherFixture } from './persistentLauncherFixture'
import { startCompositionGateway, type CompositionGateway } from './rpcRuntimeCompositionGateway'

export interface RuntimeCompositionFixture {
  readonly f: Awaited<ReturnType<typeof createPersistentLauncherFixture>>
  readonly sdk: CompositionGateway
  readonly ref: CompositionGateway['ref']
  readonly leases: OwnedModelGatewayLease[]
  readonly tunnels: RemoteReverseTunnel[]
  readonly adopted: RemoteRuntimeSnapshot[]
  readonly wire: unknown[]
  readonly defaults: RemoteSessionRuntimeOptions
  beforeLaunch(hook: (configPath: string) => Promise<void>): void
  create(extra?: Partial<RemoteSessionRuntimeOptions>): Promise<RemoteSessionRuntime>
  close(): Promise<void>
}

/** Real SDK worker + production gateway, real shell launcher and a private TCP forward, no sshd. */
export async function runtimeCompositionFixture(
  options: { anthropic?: boolean } = {}
): Promise<RuntimeCompositionFixture> {
  const f = await createPersistentLauncherFixture(true)
  const sdk = await startCompositionGateway(options.anthropic)
  const bundle = await createPhiExtensionBundle(
    process.cwd() + '/src/main/agent/engine/phi-extension'
  )
  const leases: OwnedModelGatewayLease[] = []
  const tunnels: RemoteReverseTunnel[] = []
  const runtimes: RemoteSessionRuntime[] = []
  const adopted: RemoteRuntimeSnapshot[] = []
  const wire: unknown[] = []
  let stderr = ''
  let beforeLaunch: ((configPath: string) => Promise<void>) | undefined
  const openStdio = f.session.openStdio!
  f.session.openStdio = async (command) => {
    if (command.includes('exec env -i')) {
      const candidates = await readdir(join(f.runtimeRoot, 'rpc-sessions'))
      const path = candidates
        .map((nonce) => join(f.runtimeRoot, 'rpc-sessions', nonce, 'config.json'))
        .find((candidate) => command.includes(`PHI_RPC_CONFIG=${shellQuote(candidate)}`))
      if (beforeLaunch && path) await beforeLaunch(path)
    }
    const channel = await openStdio(command)
    if (command.includes('exec env -i'))
      channel.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-32768)
      })
    return channel
  }
  f.session.execWithInput = async (command, input, options) => {
    options?.signal?.throwIfAborted()
    const channel = await f.session.openStdio!(command)
    let stdout = '',
      stderr = ''
    channel.stdout.setEncoding('utf8')
    channel.stderr.setEncoding('utf8')
    channel.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    channel.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const abort = (): void => {
      void channel.close()
    }
    options?.signal?.addEventListener('abort', abort, { once: true })
    channel.stdin.end(input)
    try {
      const result = await channel.closed
      options?.signal?.throwIfAborted()
      return { ...result, stdout, stderr }
    } finally {
      options?.signal?.removeEventListener('abort', abort)
    }
  }
  const ref = sdk.ref
  const params = {
    ...f.params,
    model: { ...ref, name: 'Composition model', reasoning: true, supportsImages: true },
    thinkingLevel: 'high' as const
  }
  const transport: RemoteSessionRuntimeOptions['transport'] = {
    projectId: f.scope.projectId,
    runtime: f.options,
    bundle,
    models: [ref],
    preparePersistentStorage: f.acquire,
    gateway: {
      async createModelGatewayLease(request) {
        const value = await sdk.create(request)
        let done!: () => void
        const closed = new Promise<void>((resolve) => {
          done = resolve
        })
        let closing: Promise<void> | undefined
        const owned = {
          ...value,
          closed,
          close: () => (closing ??= sdk.revoke(value.leaseId).finally(done))
        }
        leases.push(owned)
        return owned
      }
    },
    session: {
      ...f.session,
      async openReverseTunnel(options) {
        const sockets = new Set<Socket>()
        const server = createServer((incoming) => {
          let audit = Buffer.alloc(0)
          incoming.on('data', (chunk: Buffer) => {
            audit = Buffer.concat([audit, chunk])
            const boundary = audit.indexOf('\r\n\r\n')
            if (boundary < 0) return
            const length = Number(
              /content-length:\s*(\d+)/iu.exec(audit.subarray(0, boundary).toString())?.[1]
            )
            if (!length || audit.length < boundary + 4 + length) return
            const raw = JSON.parse(audit.subarray(boundary + 4, boundary + 4 + length).toString())
            wire.push(raw)
            audit = audit.subarray(boundary + 4 + length)
          })
          const outgoing = connect(options.localPort, '127.0.0.1')
          sockets.add(incoming)
          sockets.add(outgoing)
          for (const socket of [incoming, outgoing]) {
            socket.on('error', () => {
              incoming.destroy()
              outgoing.destroy()
            })
            socket.on('close', () => sockets.delete(socket))
          }
          incoming.pipe(outgoing)
          outgoing.pipe(incoming)
        })
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', resolve)
        })
        let done!: () => void
        const closed = new Promise<void>((resolve) => {
          done = resolve
        })
        let closing: Promise<void> | undefined
        const close = (): Promise<void> =>
          (closing ??= new Promise<void>((resolve, reject) => {
            options.signal?.removeEventListener('abort', abort)
            for (const socket of sockets) socket.destroy()
            server.close((error) => {
              done()
              if (error) reject(error)
              else resolve()
            })
          }))
        const abort = (): void => {
          void close()
        }
        options.signal?.addEventListener('abort', abort, { once: true })
        const tunnel = { remotePort: (server.address() as AddressInfo).port, closed, close }
        tunnels.push(tunnel)
        return tunnel
      }
    }
  }
  const defaults: RemoteSessionRuntimeOptions = {
    transport,
    params,
    action: { type: 'new', model: ref },
    tools: [],
    recentUserImages: () => [],
    approval: { shouldGate: () => true, requestToolApproval: () => 'denied' },
    adopt: async (snapshot) => {
      adopted.push(snapshot)
    },
    connectionOptions: { startupTimeoutMs: 15_000, promptTimeoutMs: 20_000 }
  }
  return {
    f,
    sdk,
    leases,
    tunnels,
    adopted,
    wire,
    beforeLaunch(hook: (configPath: string) => Promise<void>) {
      beforeLaunch = hook
    },
    ref,
    defaults,
    async create(extra: Partial<RemoteSessionRuntimeOptions> = {}) {
      let runtime: RemoteSessionRuntime
      try {
        runtime = await RemoteSessionRuntime.create({ ...defaults, ...extra })
      } catch (error) {
        throw new Error(`Composition CLI failed: ${stderr}`, { cause: error })
      }
      runtimes.push(runtime)
      return runtime
    },
    async close() {
      await Promise.all(runtimes.map((runtime) => runtime.close()))
      await Promise.all(tunnels.map((tunnel) => tunnel.close()))
      await Promise.all(leases.map((lease) => lease.close()))
      await sdk.close()
      await f.cleanup()
    }
  }
}
