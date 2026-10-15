import { realpathSync } from 'node:fs'
import { setTimeout as yieldForJob } from 'node:timers/promises'
import type { AgentSession, ExtensionContext, ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import type { AgentLifecycleManager } from '@oh-my-pi/pi-coding-agent/registry/agent-lifecycle'
import type { RpcChildRuntimeConfig } from '../lib/rpc-child-config'
import {
  sameRpcChildRoot,
  sameRpcChildScope,
  type RpcChildRootScope,
  type RpcChildScope
} from '../lib/rpc-child-protocol'
import {
  createRpcChildControlAck,
  parseRpcChildControlRequest,
  RPC_CHILD_CONTROL_COMMAND,
  RPC_CHILD_CONTROL_DESCRIPTION
} from '../lib/rpc-child-control'
import type { RpcChildSteerPermits } from './rpc-child-steer-permit'

export interface RpcChildControlScopes {
  publish(session: AgentSession, query: () => Readonly<RpcChildScope> | undefined): () => void
  verify(scope: RpcChildScope, session: AgentSession): boolean
}
/** Shared only by trusted factories in one generation; each query retains its Sub-local state. */
export function createRpcChildControlScopes(): RpcChildControlScopes {
  const queries = new WeakMap<AgentSession, () => Readonly<RpcChildScope> | undefined>()
  return {
    publish(session, query) {
      queries.set(session, query)
      return () => {
        if (queries.get(session) === query) queries.delete(session)
      }
    },
    verify(scope, session) {
      const actual = queries.get(session)?.()
      return !!actual && sameRpcChildScope(scope, actual)
    }
  }
}

/** Called only from the admitted background spawn, before child construction can finish. */
export async function acknowledgeOwnedRpcChildDelivery(
  session: AgentSession,
  ctx: ExtensionContext,
  root: RpcChildRootScope,
  spawnKey: string,
  signal: AbortSignal
): Promise<void> {
  const manager = session.asyncJobManager
  const active = (): boolean =>
    ctx.agent.kind === 'main' &&
    ctx.agent.id === root.rootAgentId &&
    ctx.sessionManager === session.sessionManager &&
    session.sessionId === root.rootOmpSessionId &&
    session.sessionFile === root.rootSessionFile &&
    session.asyncJobManager === manager
  const joined = AbortSignal.any([signal, AbortSignal.timeout(10000)])
  for (;;) {
    joined.throwIfAborted()
    if (!manager || !active()) throw new Error('Phi child delivery is not owned by this parent')
    // The public manager starts run() before publishing #jobs; speculative spawn can be earlier too.
    const job = manager.getJob(spawnKey)
    if (job) {
      if (job.ownerId !== root.rootAgentId || job.agentId !== spawnKey || job.type !== 'task')
        throw new Error('Phi child delivery is not owned by this parent')
      joined.throwIfAborted()
      if (!active() || manager.getJob(spawnKey) !== job)
        throw new Error('Phi child delivery target was replaced')
      manager.acknowledgeDeliveries([spawnKey])
      return
    }
    await yieldForJob(5, undefined, { signal: joined })
  }
}

export function createRpcChildControlExtension(options: {
  readonly config: Readonly<RpcChildRuntimeConfig>
  readonly root: () => Readonly<RpcChildRootScope> | undefined
  readonly signal: AbortSignal
  readonly assertPublication: () => void
  readonly steerPermits: RpcChildSteerPermits
  readonly queuedCancellation?: {
    readonly lifecycle: Pick<AgentLifecycleManager, 'manages' | 'isParking' | 'release'>
    owns(agent: AgentSession['agent']): boolean
    verify(scope: RpcChildScope, session: AgentSession): boolean
  }
}): ExtensionFactory {
  options.signal.addEventListener('abort', options.steerPermits.dispose, { once: true })
  if (options.signal.aborted) options.steerPermits.dispose()
  return (pi) => {
    let sequence = 0
    pi.registerCommand(RPC_CHILD_CONTROL_COMMAND, {
      description: RPC_CHILD_CONTROL_DESCRIPTION,
      handler: async (args, ctx) => {
        const request = parseRpcChildControlRequest(args, options.config)
        if (request.sequence !== sequence + 1) throw new Error('Phi child control replay refused')
        sequence = request.sequence
        options.signal.throwIfAborted()
        options.assertPublication()
        const root = options.root()
        const registry = pi.pi.AgentRegistry.global()
        const parent = registry.get(ctx.agent.id)
        const child = registry.get(request.scope.nativeAgentId)
        const session = child?.session
        if (
          !root ||
          !sameRpcChildRoot(request.scope, root) ||
          ctx.agent.kind !== 'main' ||
          ctx.agent.id !== root.rootAgentId ||
          parent?.kind !== 'main' ||
          !parent.session ||
          parent.session.sessionManager !== ctx.sessionManager ||
          parent.session.sessionId !== root.rootOmpSessionId ||
          parent.session.sessionFile !== root.rootSessionFile ||
          realpathSync(ctx.cwd) !== root.cwd ||
          child?.kind !== 'sub' ||
          child.parentId !== root.rootAgentId ||
          child.status !== (request.action === 'steer' ? 'running' : 'idle') ||
          child.sessionFile !== request.scope.childSessionFile ||
          !session ||
          !session.isStreaming ||
          session.sessionId !== request.scope.childOmpSessionId ||
          session.sessionManager.getSessionId() !== request.scope.childOmpSessionId ||
          session.sessionManager.getHeader()?.parentSession !== root.rootSessionFile
        ) {
          throw new Error('Phi child steer target is unavailable')
        }
        // Recheck the exact live references at the side-effect boundary, never replay the task.
        options.signal.throwIfAborted()
        if (registry.get(child.id) !== child || child.session !== session)
          throw new Error('Phi child target was replaced')
        if (request.action === 'cancel_queued') {
          const queued = options.queuedCancellation
          const assertRoot = (): void => {
            options.signal.throwIfAborted()
            options.assertPublication()
            const current = options.root()
            if (
              !current ||
              !sameRpcChildRoot(request.scope, current) ||
              registry.get(ctx.agent.id) !== parent ||
              parent.session?.sessionManager !== ctx.sessionManager ||
              parent.session.sessionId !== request.scope.rootOmpSessionId ||
              parent.session.sessionFile !== request.scope.rootSessionFile ||
              realpathSync(ctx.cwd) !== request.scope.cwd
            )
              throw new Error('Phi queued child root changed')
          }
          const assertQueued = (): void => {
            assertRoot()
            if (
              !queued ||
              !queued.lifecycle.manages(registry) ||
              registry.get(child.id) !== child ||
              child.session !== session ||
              child.status !== 'idle' ||
              child.kind !== 'sub' ||
              child.parentId !== request.scope.rootAgentId ||
              child.sessionFile !== request.scope.childSessionFile ||
              session.sessionId !== request.scope.childOmpSessionId ||
              session.sessionFile !== request.scope.childSessionFile ||
              session.sessionManager.getSessionId() !== request.scope.childOmpSessionId ||
              session.sessionManager.getHeader()?.parentSession !== request.scope.rootSessionFile ||
              realpathSync(session.sessionManager.getCwd()) !== request.scope.cwd ||
              !session.isStreaming ||
              !session.agent.state.isStreaming ||
              !queued.owns(session.agent) ||
              !queued.verify(request.scope, session) ||
              queued.lifecycle.isParking(child.id, child)
            )
              throw new Error('Phi queued child cancellation target is unavailable')
          }
          assertQueued()
          options.steerPermits.revoke(session)
          // No park wait can intervene before the SDK's exact-ref tombstone CAS.
          assertQueued()
          const [released, aborted] = await Promise.allSettled([
            queued!.lifecycle.release(child.id, child, { tombstone: true }),
            session.abort({ reason: pi.pi.USER_INTERRUPT_LABEL })
          ])
          assertRoot()
          if (released.status === 'rejected') throw released.reason
          if (aborted.status === 'rejected') throw aborted.reason
          const current = registry.get(child.id)
          if (
            released.value !== true ||
            current !== child ||
            current.status !== 'aborted' ||
            current.session !== null ||
            current.sessionFile !== request.scope.childSessionFile
          )
            throw new Error('Phi queued child cancellation was not confirmed')
          ctx.ui.notify(JSON.stringify(createRpcChildControlAck(request, options.config)), 'info')
          return
        }
        if (options.steerPermits.hasPending(session)) {
          ctx.ui.notify(
            JSON.stringify(createRpcChildControlAck(request, options.config, false)),
            'info'
          )
          return
        }
        const release = options.steerPermits.grant(
          session,
          request.scope,
          request.id,
          request.message
        )
        try {
          await session.steer(request.message)
          options.signal.throwIfAborted()
          ctx.ui.notify(JSON.stringify(createRpcChildControlAck(request, options.config)), 'info')
        } catch (error) {
          release()
          throw error
        }
      }
    })
  }
}
