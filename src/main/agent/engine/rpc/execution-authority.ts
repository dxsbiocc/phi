import { randomUUID } from 'node:crypto'
import {
  approvalIdentifier,
  createApprovalEnvelope,
  sameApprovalIdentity,
  validApprovalIdentity
} from '../phi-extension/lib/rpc-approval-protocol'
import {
  executionLaunchIdentity,
  executionCapability,
  executionInput,
  executionRoster,
  MAX_EXECUTION_CALLS,
  parseExecutionMessage,
  RPC_EXECUTION_COMMAND,
  RPC_EXECUTION_DESCRIPTION,
  signExecutionMessage,
  type RpcExecutionControl,
  type RpcExecutionIdentity,
  type RpcExecutionLaunchIdentity,
  type RpcExecutionTool,
  type SignedExecutionMessage
} from '../phi-extension/lib/rpc-execution-protocol'
import { RpcConnection } from './connection'
import type { RpcApprovalRun } from './approval-bridge'
import type { RpcHostToolRun } from './host-tool-bridge'
import type { RpcControlChannel, RpcFrame, RpcPromptOptions, RpcPromptResult } from './types'

export type RpcExecutionRun = RpcApprovalRun & RpcHostToolRun
interface RunState {
  binding: RpcExecutionRun
  controller: AbortController
  sequence: number
  originSequence: number
  finished: boolean
  retirement?: Promise<void>
  calls: Map<string, { name: string; digest: string }>
  detach(): void
}
export interface RpcExecutionAuthorityOptions {
  connection: RpcConnection
  identity: RpcExecutionLaunchIdentity
  capability: string
  roster: readonly RpcExecutionTool[]
  signal?: AbortSignal
}

/** Session-owned standalone coordinator. No dialog/host frame can mint main-call authority. */
export class RpcExecutionAuthority {
  #capability: string
  private readonly connection: RpcConnection
  private readonly channel: RpcControlChannel
  private readonly launch: RpcExecutionLaunchIdentity
  private readonly roster: ReturnType<typeof executionRoster>
  private identity?: RpcExecutionIdentity
  private readonly cleanups: Array<() => void> = []
  private sequence = 0
  private run?: RunState
  private latestRun?: RunState
  private latestControl?: RpcExecutionControl
  private control?: { request: RpcExecutionControl; ack?: SignedExecutionMessage }
  private busy = false
  private prompting = false
  private disposed = false
  private closing?: Promise<void>

  private constructor(options: RpcExecutionAuthorityOptions) {
    this.connection = options.connection
    this.channel = options.connection.bindControl()
    this.launch = executionLaunchIdentity(options.identity)
    this.roster = executionRoster(options.roster)
    if (
      !executionCapability(options.capability) ||
      !validApprovalIdentity({ ...this.launch, ompSessionId: 'validate', runId: 'validate' }) ||
      this.launch.generation !== this.channel.generation
    )
      throw new Error('Invalid execution authority configuration')
    if (JSON.stringify({ identity: this.launch, roster: this.roster }).includes(options.capability))
      throw new Error('Execution capability overlaps public configuration')
    this.#capability = options.capability
    this.cleanups.push(this.channel.onFrame((frame) => this.receive(frame)))
    for (const signal of [this.channel.signal, options.signal]) {
      if (this.disposed) break
      if (!signal) continue
      const abort = (): void => {
        this.retireSafely()
      }
      signal.addEventListener('abort', abort, { once: true })
      this.cleanups.push(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) this.retireSafely()
    }
  }
  static async create(options: RpcExecutionAuthorityOptions): Promise<RpcExecutionAuthority> {
    let authority: RpcExecutionAuthority | undefined
    try {
      authority = new RpcExecutionAuthority(options)
      const state = await authority.connection.request<{ sessionId: string }>({ type: 'get_state' })
      if (!approvalIdentifier(state.sessionId))
        throw new Error('Execution authority session unavailable')
      authority.identity = Object.freeze({ ...authority.launch, ompSessionId: state.sessionId })
      await authority.command('activate', 'bridge-ready')
      return authority
    } catch {
      if (authority) await authority.dispose().catch(() => undefined)
      else await options.connection.close().catch(() => undefined)
      throw new Error('Execution authority activation failed')
    }
  }
  currentRun(): RpcExecutionRun | undefined {
    return this.run?.binding
  }
  sessionIdentity(): Readonly<RpcExecutionIdentity> {
    if (!this.identity || this.disposed) throw new Error('Execution authority unavailable')
    return this.identity
  }
  async beginRun(runId: string, signal?: AbortSignal): Promise<RpcExecutionRun> {
    if (
      !approvalIdentifier(runId) ||
      runId === 'bridge-ready' ||
      this.run ||
      (this.latestRun && !this.latestRun.finished) ||
      this.busy ||
      this.prompting ||
      this.disposed ||
      signal?.aborted
    )
      throw new Error('Execution authority cannot begin this run')
    const controller = new AbortController()
    const abort = (): void => {
      this.retireSafely()
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await this.command('begin', runId)
      if (signal?.aborted || this.disposed) throw new Error('Execution authority run cancelled')
      const binding: RpcExecutionRun = Object.freeze({
        id: runId,
        signal: controller.signal,
        authorizeCall: (
          toolCallId: string,
          toolName: string,
          input: Readonly<Record<string, unknown>>,
          digestOrSignal: string | AbortSignal,
          signal?: AbortSignal
        ): 'main' | undefined => {
          const cancel = typeof digestOrSignal === 'string' ? signal : digestOrSignal
          if (
            this.disposed ||
            this.run !== state ||
            controller.signal.aborted ||
            !cancel ||
            cancel.aborted
          )
            return undefined
          const known = state.calls.get(toolCallId)
          const tool = this.roster.tools.find((candidate) => candidate.name === toolName)
          if (!known || !tool || known.name !== toolName || !this.identity) return undefined
          try {
            const digest = createApprovalEnvelope(
              { ...this.identity, runId },
              toolCallId,
              toolName,
              executionInput(tool, input)
            ).inputDigest
            return known.digest === digest &&
              (typeof digestOrSignal !== 'string' || digestOrSignal === digest)
              ? 'main'
              : undefined
          } catch {
            return undefined
          }
        }
      })
      const state: RunState = {
        binding,
        controller,
        sequence: this.sequence,
        originSequence: 0,
        finished: false,
        calls: new Map(),
        detach: () => signal?.removeEventListener('abort', abort)
      }
      // From this point cancellation stops the actual agent, retaining the ready bridge for future runs.
      signal?.removeEventListener('abort', abort)
      const stop = (): void => {
        void this.cancelRun().catch(() => {
          this.retireSafely()
        })
      }
      signal?.addEventListener('abort', stop, { once: true })
      state.detach = () => signal?.removeEventListener('abort', stop)
      this.run = state
      this.latestRun = state
      if (signal?.aborted) await this.cancelRun()
      return binding
    } catch {
      signal?.removeEventListener('abort', abort)
      controller.abort()
      await this.dispose().catch(() => undefined)
      throw new Error('Execution authority run binding failed')
    }
  }
  async prompt(message: string, options?: RpcPromptOptions): Promise<RpcPromptResult> {
    const state = this.run
    if (!state || state.controller.signal.aborted || this.prompting || this.busy || this.disposed)
      throw new Error('Execution authority requires one active main run')
    this.prompting = true
    try {
      return await this.connection.prompt(message, options)
    } finally {
      this.prompting = false
      if (!this.disposed) await this.finishState(state)
    }
  }
  async cancelRun(): Promise<void> {
    const state = this.run
    if (!state) return
    this.retireRun()
    await this.connection.abort()
    if (!this.disposed && (state.retirement || !this.prompting)) await this.finishState(state)
  }
  async finishRun(runId: string): Promise<void> {
    if (this.disposed) return
    const state = this.latestRun
    if (!state || state.binding.id !== runId)
      throw new Error('Execution authority cannot finish a different active run')
    await this.finishState(state)
  }
  private finishState(state: RunState): Promise<void> {
    // Both prompt.finally and an arbitrarily late abort ACK own this same result.
    // Reuse it before examining a successor's global busy/prompting state.
    if (state.retirement) return state.retirement
    if (this.disposed) return Promise.resolve()
    if (this.prompting || this.busy || this.latestRun !== state || (this.run && this.run !== state))
      return Promise.reject(new Error('Execution authority cannot finish a different active run'))
    state.retirement = Promise.resolve().then(async () => {
      try {
        await this.command('end', state.binding.id)
        state.finished = true
      } catch {
        await this.dispose().catch(() => undefined)
        throw new Error('Execution authority retirement failed')
      }
    })
    if (this.run === state) this.retireRun()
    return state.retirement
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing
    this.disposed = true
    // Publish cleanup ownership before abort listeners can reenter this method.
    this.closing = Promise.resolve().then(() => this.connection.close())
    void this.closing.catch(() => undefined)
    this.retireRun()
    this.latestRun = undefined
    this.latestControl = undefined
    this.#capability = ''
    this.control = undefined
    for (const detach of this.cleanups.splice(0)) detach()
    return this.closing
  }
  private retireSafely(): void {
    void this.dispose().catch(() => undefined)
  }
  private retireRun(): void {
    const state = this.run
    this.run = undefined
    state?.detach()
    state?.calls.clear()
    state?.controller.abort()
  }
  private async command(action: RpcExecutionControl['action'], runId: string): Promise<void> {
    if (this.disposed || this.busy || !this.identity)
      throw new Error('Execution authority control unavailable')
    this.busy = true
    try {
      const data = await this.connection.request<{
        commands: Array<{ name: string; description?: string; source: string }>
      }>({ type: 'get_available_commands' })
      const commands = data.commands?.filter((command) => command.name === RPC_EXECUTION_COMMAND)
      if (
        !commands ||
        commands.length !== 1 ||
        commands[0].source !== 'extension' ||
        commands[0].description !== RPC_EXECUTION_DESCRIPTION ||
        this.disposed
      )
        throw new Error('Execution authority command unavailable')
      const request: RpcExecutionControl = {
        ...this.identity,
        runId,
        type: 'phi_rpc_execution_control',
        protocolVersion: 1,
        rosterHash: this.roster.hash,
        sequence: this.sequence + 1,
        requestId: randomUUID(),
        action
      }
      const pending = { request, ack: undefined as SignedExecutionMessage | undefined }
      this.control = pending
      const result = await this.connection.prompt(
        `/${RPC_EXECUTION_COMMAND} ${JSON.stringify(signExecutionMessage(request, this.#capability))}`,
        { timeoutMs: 10000 }
      )
      if (
        this.disposed ||
        this.control !== pending ||
        !pending.ack ||
        result.agentInvoked ||
        result.status !== 'completed' ||
        !result.sessionSettled
      )
        throw new Error('Execution authority control not confirmed')
      this.sequence = request.sequence
      this.latestControl = request
    } finally {
      this.control = undefined
      this.busy = false
    }
  }
  private receive(frame: RpcFrame): void {
    if (
      this.disposed ||
      frame.type !== 'extension_ui_request' ||
      frame.method !== 'notify' ||
      typeof frame.message !== 'string' ||
      !this.identity
    )
      return
    const message = parseExecutionMessage(frame.message, this.#capability)
    if (
      !message ||
      message.rosterHash !== this.roster.hash ||
      !sameApprovalIdentity(message, { ...this.identity, runId: message.runId })
    )
      return
    if (message.type === 'phi_rpc_execution_ack') {
      const pending = this.control
      if (
        pending &&
        !pending.ack &&
        message.requestId === pending.request.requestId &&
        message.action === pending.request.action &&
        message.sequence === pending.request.sequence &&
        message.runId === pending.request.runId
      )
        pending.ack = message
      return
    }
    if (message.type === 'phi_rpc_execution_retired' && message.reason !== 'finished') {
      const controls = [this.control?.request, this.latestControl]
      if (
        controls.some(
          (control) =>
            control && control.sequence === message.sequence && control.runId === message.runId
        )
      )
        this.retireSafely()
      return
    }
    const state = this.run
    if (!state || message.runId !== state.binding.id || message.sequence !== state.sequence) return
    if (message.type === 'phi_rpc_execution_retired') {
      this.retireRun()
      return
    }
    if (message.type !== 'phi_rpc_execution_origin') return
    if (
      message.originSequence !== state.originSequence + 1 ||
      state.calls.has(message.toolCallId) ||
      state.calls.size >= MAX_EXECUTION_CALLS ||
      !this.roster.tools.some((tool) => tool.name === message.toolName)
    ) {
      void this.cancelRun().catch(() => {
        this.retireSafely()
      })
      return
    }
    state.originSequence = message.originSequence
    state.calls.set(message.toolCallId, { name: message.toolName, digest: message.inputDigest })
  }
}
