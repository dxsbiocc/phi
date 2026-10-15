import type { RpcChildRuntimeConfig } from '../../phi-extension/lib/rpc-child-config'
import {
  createRpcChildSteerRequest,
  RPC_CHILD_CONTROL_COMMAND,
  RPC_CHILD_CONTROL_DESCRIPTION,
  parseRpcChildControlAck
} from '../../phi-extension/lib/rpc-child-control'
import type { RpcConnection } from '../connection'
import { withRemoteSignal } from '../history-pager'
import type { RpcChildAuthority } from './child-authority'
import type { RpcChildRunSnapshot } from './types'

const terminal = (run: Readonly<RpcChildRunSnapshot>): boolean => run.completedAt !== undefined
export interface RpcChildWaitOptions {
  readonly ids?: readonly string[]
  readonly mode?: 'all' | 'any'
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
export interface RpcChildWaitResult {
  readonly runs: readonly Readonly<RpcChildRunSnapshot>[]
  readonly timedOut: boolean
}

/** Controls existing attested native children; it never launches or replays a task. */
export class RpcChildRunControls {
  private sequence = 0
  private steering = false
  constructor(
    private readonly options: {
      readonly connection: RpcConnection
      readonly authority: RpcChildAuthority
      readonly config: Readonly<RpcChildRuntimeConfig>
      readonly signal: AbortSignal
      readonly onUnconfirmed?: (error: Error) => void
    }
  ) {}
  listRuns(): readonly Readonly<RpcChildRunSnapshot>[] {
    this.assertActive()
    return this.options.authority.registry.records()
  }
  status(id: string): Readonly<RpcChildRunSnapshot> {
    this.assertActive()
    const registry = this.options.authority.registry
    const run = registry.getRecord(id) ?? registry.recordForNative(id)
    if (!run) throw new Error('Child run is not owned by this session generation')
    return run
  }
  async wait(options: RpcChildWaitOptions = {}): Promise<RpcChildWaitResult> {
    this.assertActive()
    const timeoutMs = options.timeoutMs ?? 120000
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > 600000 ||
      (options.mode !== undefined && options.mode !== 'all' && options.mode !== 'any') ||
      (options.ids !== undefined && (!Array.isArray(options.ids) || options.ids.length > 64))
    )
      throw new Error('Invalid child wait options')
    const runs = options.ids
      ? [...new Set(options.ids)].map((id) => this.status(id))
      : this.listRuns().filter((run) => !terminal(run))
    options.signal?.throwIfAborted()
    if (!runs.length || (options.mode === 'any' ? runs.some(terminal) : runs.every(terminal)))
      return { runs, timedOut: false }
    if (!timeoutMs) return { runs, timedOut: true }
    const controller = new AbortController()
    const signal = AbortSignal.any([
      controller.signal,
      this.options.signal,
      this.options.connection.bindControl().signal,
      ...(options.signal ? [options.signal] : [])
    ])
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const pending = runs
        .filter((run) => !terminal(run))
        .map((run) => this.options.authority.registry.waitForTerminal(run.nativeId, signal))
      await (options.mode === 'any' ? Promise.race(pending) : Promise.all(pending))
      options.signal?.throwIfAborted()
      this.assertActive()
      return { runs: runs.map((run) => this.status(run.id)), timedOut }
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
  async stop(id: string, signal?: AbortSignal): Promise<Readonly<RpcChildRunSnapshot>> {
    const run = this.status(id)
    signal?.throwIfAborted()
    if (terminal(run)) throw new Error('Child run has already finished')
    const stopping = this.options.authority.cancelChild(run.nativeId)
    await withRemoteSignal(stopping, this.joined(signal))
    return this.status(run.id)
  }
  async steer(id: string, message: string, signal?: AbortSignal): Promise<void> {
    const record = this.status(id)
    const registry = this.options.authority.registry
    const run = registry.getRun(record.id)
    if (
      typeof message !== 'string' ||
      !message.trim() ||
      !run ||
      record.status !== 'running' ||
      registry.current(run.scope) !== run ||
      this.steering
    )
      throw new Error('Child steer target is unavailable')
    const request = createRpcChildSteerRequest(
      this.options.config,
      run.scope,
      this.sequence + 1,
      message
    )
    this.steering = true
    const joined = AbortSignal.any([this.joined(signal), AbortSignal.timeout(10000)])
    let acknowledged = false
    let submitted = false
    let rejectProof!: (error: Error) => void
    let detach!: () => void
    const proof = new Promise<void>((resolve, reject) => {
      rejectProof = reject
      const off = this.options.connection.bindControl().onFrame((frame) => {
        if (
          frame.type === 'extension_ui_request' &&
          frame.method === 'notify' &&
          frame.notifyType === 'info'
        ) {
          const ack = parseRpcChildControlAck(frame.message, request, this.options.config)
          if (!ack) return
          acknowledged = true
          if (ack.accepted) resolve()
          else reject(new Error('Child steering is busy until its previous message is consumed'))
        }
      })
      detach = off
    })
    void proof.catch(() => undefined)
    try {
      joined.throwIfAborted()
      const available = await withRemoteSignal(
        this.options.connection.request<{
          commands?: Array<{ name?: string; source?: string; description?: string }>
        }>({ type: 'get_available_commands' }),
        joined
      )
      const commands =
        available.commands?.filter((command) => command.name === RPC_CHILD_CONTROL_COMMAND) ?? []
      if (
        commands.length !== 1 ||
        commands[0].source !== 'extension' ||
        commands[0].description !== RPC_CHILD_CONTROL_DESCRIPTION ||
        registry.current(run.scope) !== run
      )
        throw new Error('Child control command is unavailable')
      this.sequence = request.sequence
      submitted = true
      const result = await withRemoteSignal(
        this.options.connection.prompt(`/${RPC_CHILD_CONTROL_COMMAND} ${JSON.stringify(request)}`),
        joined
      )
      if (result.agentInvoked || result.status !== 'completed')
        throw new Error('Child steering could not be confirmed')
      await withRemoteSignal(proof, joined)
      if (!acknowledged) throw new Error('Child steering acknowledgement is absent')
    } catch (error) {
      if (submitted && !acknowledged)
        this.options.onUnconfirmed?.(new Error('Child steering was not confirmed'))
      throw error
    } finally {
      rejectProof(new Error('Child steering ended'))
      detach?.()
      this.steering = false
    }
  }
  private joined(signal?: AbortSignal): AbortSignal {
    this.assertActive()
    return AbortSignal.any([
      this.options.signal,
      this.options.connection.bindControl().signal,
      ...(signal ? [signal] : [])
    ])
  }
  private assertActive(): void {
    if (!this.options.authority.registry.isActive) throw new Error('Child runtime is unavailable')
    this.options.signal.throwIfAborted()
    this.options.connection.bindControl().signal.throwIfAborted()
  }
}
