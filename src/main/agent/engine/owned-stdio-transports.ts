import { AsyncLocalStorage } from 'node:async_hooks'
import { VERSION } from '@oh-my-pi/pi-coding-agent'
import { StdioTransport } from '@oh-my-pi/pi-coding-agent/mcp/transports/stdio'

interface OwnedChild {
  pid: number
  exited: Promise<unknown>
  kill(signal: string): unknown
}

const owners = new AsyncLocalStorage<OwnedStdioTransportScope>()
const spawning = new AsyncLocalStorage<{ owner: OwnedStdioTransportScope; active: boolean }>()
const SDK_VERSION = '18.1.10'
const CLEANUP_TIMEOUT_MS = 10_000
let hooksInstalled = false
let connectHook: StdioTransport['connect'] | undefined
let spawnHook: ((...args: unknown[]) => unknown) | undefined
let bunRuntime: object | undefined

function unsupported(): Error {
  return new Error('Unsupported MCP SDK stdio cleanup API; Phi cannot safely lease this transport')
}

function installHooks(): void {
  if (hooksInstalled) {
    if (
      StdioTransport.prototype.connect !== connectHook ||
      !bunRuntime ||
      Reflect.get(bunRuntime, 'spawn') !== spawnHook
    )
      throw unsupported()
    return
  }
  if (VERSION !== SDK_VERSION) throw unsupported()
  const connect = StdioTransport.prototype.connect
  const close = StdioTransport.prototype.close
  const bun: unknown = Reflect.get(globalThis, 'Bun')
  if (
    !bun ||
    (typeof bun !== 'object' && typeof bun !== 'function') ||
    typeof connect !== 'function' ||
    typeof close !== 'function'
  )
    throw unsupported()
  const spawn: unknown = Reflect.get(bun, 'spawn')
  if (typeof spawn !== 'function') throw unsupported()
  const scopedSpawn = function (this: unknown, ...args: unknown[]): unknown {
    const result: unknown = Reflect.apply(spawn, this, args)
    const context = spawning.getStore()
    if (context?.active) context.owner.captureChild(result)
    return result
  }
  if (!Reflect.set(bun, 'spawn', scopedSpawn) || Reflect.get(bun, 'spawn') !== scopedSpawn)
    throw unsupported()
  StdioTransport.prototype.connect = function (): Promise<void> {
    const owner = owners.getStore()
    if (!owner) return connect.call(this)
    if (owner.stopping) return Promise.reject(new Error('Owned MCP stdio connection is closing'))
    owner.captureTransport(this)
    const context = { owner, active: true }
    const pending = spawning.run(context, () => connect.call(this))
    owner.captureConnect(pending)
    void pending
      .finally(() => {
        context.active = false
      })
      .catch(() => undefined)
    return pending
  }
  connectHook = StdioTransport.prototype.connect
  spawnHook = scopedSpawn
  bunRuntime = bun
  hooksInstalled = true
}

/**
 * The SDK returns timeout failures before its background close completes. Capture at its
 * public connect seam, before spawn/initialize, so failed handshakes retain ownership too.
 * Async-local ownership leaves unrelated SDK transports and subprocesses unchanged.
 */
export class OwnedStdioTransportScope {
  stopping = false
  private readonly transports = new Set<StdioTransport>()
  private readonly connecting = new Set<Promise<void>>()
  private readonly children = new Set<OwnedChild>()
  private readonly exited = new WeakSet<OwnedChild>()
  private complete?: Promise<void>
  private unsupportedChild = false

  constructor() {
    installHooks()
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    installHooks()
    if (this.stopping) return Promise.reject(new Error('Owned MCP stdio connection is closing'))
    return owners.run(this, operation)
  }

  captureTransport(transport: StdioTransport): void {
    if (this.transports.has(transport)) return
    this.transports.add(transport)
    const close = transport.close.bind(transport)
    let closing: Promise<void> | undefined
    transport.close = () => (closing ??= close())
  }

  captureConnect(pending: Promise<void>): void {
    this.connecting.add(pending)
    void pending.finally(() => this.connecting.delete(pending)).catch(() => undefined)
  }

  captureChild(value: unknown): void {
    if (!value || typeof value !== 'object') {
      this.unsupportedChild = true
      throw unsupported()
    }
    const pid: unknown = Reflect.get(value, 'pid')
    const exited: unknown = Reflect.get(value, 'exited')
    const kill: unknown = Reflect.get(value, 'kill')
    if (
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid < 1 ||
      !exited ||
      typeof exited !== 'object' ||
      typeof Reflect.get(exited, 'then') !== 'function' ||
      typeof kill !== 'function'
    ) {
      this.unsupportedChild = true
      throw unsupported()
    }
    const child = value as OwnedChild
    this.children.add(child)
    void child.exited.then(() => this.exited.add(child)).catch(() => undefined)
  }

  private async finish(): Promise<void> {
    // connect() can still be resolving its spawn command when an outer timeout fires.
    // Wait for that stage before closing, so no child can spawn after an empty close.
    await Promise.allSettled([...this.connecting])
    await Promise.allSettled([...this.transports].map((transport) => transport.close()))
    for (const child of this.children) {
      // SDK close is bounded and can return without an exit acknowledgement. Preserve
      // the real handle and require exited, even after its private handle was cleared.
      try {
        if (!this.exited.has(child)) child.kill('SIGKILL')
      } catch {
        /* A completed handle is already safe. */
      }
    }
    await Promise.all([...this.children].map((child) => child.exited))
    if (this.unsupportedChild) throw unsupported()
  }

  /** A rejected drain leaves the caller's lease held; it must never report safe release. */
  async drain(): Promise<void> {
    this.stopping = true
    this.complete ??= this.finish()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.complete,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error('Owned MCP stdio cleanup timed out; environment remains leased')),
            CLEANUP_TIMEOUT_MS
          )
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
