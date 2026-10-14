import type { SessionRun } from '../../../session/session-runner-registry'
import {
  CHILD_ATTEST_COMMAND,
  CHILD_ATTEST_DESCRIPTION,
  verifyRpcChildAttestation,
  type RpcChildRuntimeConfig
} from '../../phi-extension/lib/rpc-child-config'
import {
  validateRpcChildRoot,
  type RpcChildRootScope
} from '../../phi-extension/lib/rpc-child-protocol'
import type { RpcConnection } from '../connection'
import type { RpcExecutionAuthority } from '../execution-authority'
import { withRemoteSignal } from '../history-pager'
import type { RpcApprovalEvent } from '../approval-bridge'
import { RpcChildAuthority } from './child-authority'
import type { RpcChildApprovalOptions } from './child-approval-bridge'
import { RpcChildHostUriBridge } from './host-uri-bridge'
import { ProductionChildLedger } from './production-child-ledger'
import {
  assertPreparedProductionChildConfig,
  type PreparedProductionChildConfig
} from './production-child-config'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const composedGenerations = new WeakSet<AbortSignal>()
export type ProductionChildRootAttachment = Pick<
  RpcChildRootScope,
  'rootOmpSessionId' | 'rootSessionFile'
>

/** Discovered local command + independent HMAC + actual get_state identity, without invoking a model. */
export async function attestProductionChildRuntime(
  connection: RpcConnection,
  config: RpcChildRuntimeConfig,
  root: ProductionChildRootAttachment,
  signal: AbortSignal
): Promise<Readonly<RpcChildRootScope>> {
  const channel = connection.bindControl()
  const joined = AbortSignal.any([signal, channel.signal, AbortSignal.timeout(10000)])
  const stateMatches = async (): Promise<void> => {
    const state = await withRemoteSignal(connection.request<unknown>({ type: 'get_state' }), joined)
    if (
      !record(state) ||
      state.sessionId !== root.rootOmpSessionId ||
      state.sessionFile !== root.rootSessionFile
    )
      throw new Error('Child runtime differs from the actual attached root session')
  }
  if (channel.generation !== config.generation)
    throw new Error('Child runtime attestation generation differs')
  await stateMatches()
  const list = await withRemoteSignal(
    connection.request<unknown>({ type: 'get_available_commands' }),
    joined
  )
  const matches =
    record(list) && Array.isArray(list.commands)
      ? list.commands.filter((command) => record(command) && command.name === CHILD_ATTEST_COMMAND)
      : []
  if (
    matches.length !== 1 ||
    !record(matches[0]) ||
    matches[0].source !== 'extension' ||
    matches[0].description !== CHILD_ATTEST_DESCRIPTION
  )
    throw new Error('Child runtime attestation command is unavailable')
  let resolve!: (identity: Readonly<RpcChildRootScope>) => void, reject!: (error: Error) => void
  const proof = new Promise<Readonly<RpcChildRootScope>>((yes, no) => {
    resolve = yes
    reject = no
  })
  void proof.catch(() => undefined)
  const detach = channel.onFrame((frame) => {
    if (frame.type === 'agent_start') reject(new Error('Child runtime attestation invoked a model'))
    if (
      frame.type !== 'extension_ui_request' ||
      frame.method !== 'notify' ||
      typeof frame.message !== 'string'
    )
      return
    let value: unknown
    try {
      value = JSON.parse(frame.message)
    } catch {
      return
    }
    if (!record(value) || value.type !== 'phi_rpc_child_attestation') return
    let identity: Readonly<RpcChildRootScope>
    try {
      identity = validateRpcChildRoot(value.identity)
    } catch {
      reject(new Error('Child runtime attestation has an invalid root identity'))
      return
    }
    if (
      frame.notifyType !== 'info' ||
      Buffer.byteLength(frame.message) > 16384 ||
      identity.rootOmpSessionId !== root.rootOmpSessionId ||
      identity.rootSessionFile !== root.rootSessionFile ||
      !verifyRpcChildAttestation(value, config, identity)
    )
      reject(new Error('Child runtime attestation differs from its trusted publication'))
    else resolve(identity)
  })
  try {
    const [result, identity] = await withRemoteSignal(
      Promise.all([connection.prompt(`/${CHILD_ATTEST_COMMAND} ${config.nonce}`), proof]),
      joined
    )
    if (result.agentInvoked || result.status !== 'completed' || !result.sessionSettled)
      throw new Error('Child runtime attestation did not settle locally')
    await stateMatches()
    return identity
  } finally {
    detach()
  }
}

export interface ProductionChildRuntimeOptions {
  readonly connection: RpcConnection
  readonly execution: RpcExecutionAuthority
  readonly prepared: PreparedProductionChildConfig
  /** Previously verified attached root journal and SDK identity. */
  readonly root: ProductionChildRootAttachment
  readonly currentParentRun: () => SessionRun | undefined
  readonly approval: RpcChildApprovalOptions
  readonly onDenied: (parent: SessionRun, event: RpcApprovalEvent) => void
  readonly onError: (error: Error) => void
  readonly signal: AbortSignal
}

/** Generation composition API. Normal main turn completion never disposes this authority. */
export class ProductionChildRuntime {
  private readonly ledger: ProductionChildLedger
  private readonly authority: RpcChildAuthority
  private readonly uri: RpcChildHostUriBridge
  private readonly detach: Array<() => void> = []
  private readonly childParents = new Map<string, SessionRun>()
  private readonly stops = new Map<string, Promise<void>>()
  private disposed = false

  private constructor(
    private readonly options: ProductionChildRuntimeOptions,
    identity: Readonly<RpcChildRootScope>
  ) {
    this.options = options = Object.freeze({
      ...options,
      root: Object.freeze({ ...options.root }),
      approval: Object.freeze({ ...options.approval })
    })
    const { config } = options.prepared
    const channel = options.connection.bindControl()
    const execution = options.execution.sessionIdentity()
    if (
      execution.phiSessionId !== identity.phiSessionId ||
      execution.projectId !== identity.projectId ||
      execution.cwd !== identity.cwd ||
      execution.generation !== identity.generation ||
      execution.ompSessionId !== identity.rootOmpSessionId ||
      execution.nonce !== config.nonce ||
      channel.generation !== identity.generation
    )
      throw new Error('Child runtime differs from its actual execution generation')
    options.signal.throwIfAborted()
    channel.signal.throwIfAborted()
    this.ledger = new ProductionChildLedger({
      phiSessionId: config.phiSessionId,
      generation: config.generation,
      currentParentRun: options.currentParentRun,
      isNativeTerminal: (nativeId, parentRunId) =>
        !this.authority.registry.nativeChildren(parentRunId).includes(nativeId),
      onStop: (parent) => {
        void this.stopParent(parent.runId).catch((error: unknown) => this.fail(error))
      }
    })
    this.authority = new RpcChildAuthority({
      identity,
      manifestBinding: config.manifestBinding,
      profiles: config.profiles,
      capability: config.capability,
      signal: channel.signal,
      captureParent: (started) => this.ledger.captureParent(started),
      approval: {
        ...options.approval,
        onEvent: (event) => {
          const parent = this.captureApprovalParent(event)
          if (!parent) {
            this.fail(new Error('Child approval lacks its registered Phi parent'))
            return
          }
          if (event.type === 'approval_denied') options.onDenied(parent, event)
          return options.approval.onEvent?.(event)
        }
      },
      cancelNativeChild: async (nativeAgentId) => {
        const response = await options.connection.request<unknown>({
          type: 'cancel_subagent',
          subagentId: nativeAgentId
        })
        return record(response) && response.cancelled === true
      }
    })
    this.detach.push(
      options.execution.onTaskOrigin((event) => this.ledger.remember(event)),
      channel.onFrame((frame) => {
        this.authority.observe(frame)
        this.ledger.observeTaskEnd(frame)
      })
    )
    this.uri = new RpcChildHostUriBridge({ channel, authority: this.authority })
    const dispose = (): void => this.dispose()
    for (const signal of [options.signal, channel.signal]) {
      signal.addEventListener('abort', dispose, { once: true })
      this.detach.push(() => signal.removeEventListener('abort', dispose))
      if (signal.aborted) this.dispose()
    }
  }

  static async create(options: ProductionChildRuntimeOptions): Promise<ProductionChildRuntime> {
    assertPreparedProductionChildConfig(options.prepared)
    if (!options.execution.allowsNativeTask())
      throw new Error('Execution authority has no native task opt-in')
    const channel = options.connection.bindControl()
    if (composedGenerations.has(channel.signal))
      throw new Error('Child generation was already composed')
    composedGenerations.add(channel.signal)
    const { config } = options.prepared
    const identity = await attestProductionChildRuntime(
      options.connection,
      config,
      options.root,
      options.signal
    )
    const runtime = new ProductionChildRuntime(options, identity)
    try {
      await withRemoteSignal(
        options.connection.request({ type: 'set_subagent_subscription', level: 'events' }),
        options.signal
      )
      await withRemoteSignal(
        options.connection.request({
          type: 'set_host_uri_schemes',
          schemes: [{ scheme: 'phi-child', writable: true }]
        }),
        options.signal
      )
      options.signal.throwIfAborted()
      channel.signal.throwIfAborted()
      return runtime
    } catch (error) {
      runtime.dispose()
      throw error
    }
  }

  /** Official cancellation ACK and observed aborted lifecycle must precede parent/channel teardown. */
  stopParent(parentRunId: string): Promise<void> {
    if (this.disposed || this.options.signal.aborted)
      return Promise.reject(new Error('Child runtime cancellation is unavailable'))
    const channel = this.options.connection.bindControl()
    if (channel.signal.aborted)
      return Promise.reject(new Error('Child runtime cancellation is unavailable'))
    const known = this.stops.get(parentRunId)
    if (known) return known
    this.authority.registry.cancelParent(parentRunId)
    const signal = AbortSignal.any([
      channel.signal,
      this.options.signal,
      AbortSignal.timeout(10000)
    ])
    const stopping = Promise.resolve()
      .then(async () => {
        await this.ledger.waitForStarts(parentRunId, signal)
        await withRemoteSignal(this.authority.cancelParent(parentRunId), signal)
        this.assertParentSettled(parentRunId)
      })
      .finally(() => {
        if (this.stops.get(parentRunId) === stopping) this.stops.delete(parentRunId)
      })
    this.stops.set(parentRunId, stopping)
    return stopping
  }

  /** Tentative/unregistered native starts remain outstanding until a real matching terminal event. */
  assertParentSettled(parentRunId: string): void {
    if (this.disposed || this.options.connection.bindControl().signal.aborted)
      throw new Error('Child runtime settlement authority is unavailable')
    this.ledger.assertNoPendingStarts(parentRunId)
    if (this.authority.registry.nativeChildren(parentRunId).length)
      throw new Error('Native children have not reached an observed terminal lifecycle')
  }

  parentForChild(childRunId: string): SessionRun | undefined {
    const cached = this.childParents.get(childRunId)
    if (cached) return cached
    if (this.disposed) return undefined
    const child = this.authority.registry.snapshot().find((run) => run.id === childRunId)
    const parent = child && this.ledger.parentForNative(child.scope.nativeAgentId)
    if (parent) this.childParents.set(childRunId, parent)
    return parent
  }

  /** Local revocation only; disconnect cannot establish that the remote process stopped. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const detach of this.detach.splice(0)) detach()
    this.uri.dispose()
    this.ledger.dispose()
    // Submitted writer callbacks still need the originating parent for their sole terminal event.
  }

  private captureApprovalParent(event: RpcApprovalEvent): SessionRun | undefined {
    if (
      event.sessionId !== this.options.prepared.config.phiSessionId ||
      event.request.agentRunId !== event.runId
    )
      return undefined
    return this.parentForChild(event.runId)
  }

  private fail(error: unknown): void {
    this.dispose()
    try {
      this.options.onError(error instanceof Error ? error : new Error('Child runtime failed'))
    } catch {
      this.dispose()
    }
  }
}
