import type { ExtensionContext, ExtensionFactory, AgentSession } from '@oh-my-pi/pi-coding-agent'
import type { StreamFn } from '@oh-my-pi/pi-agent-core'
import {
  createNativeStreamIntegrityAdapter,
  validateNativeStreamScope,
  type TrustedNativeStreamScope
} from '../lib/rpc-native-stream-adapter'
import { integrity } from '../lib/rpc-native-sse'
import { RPC_CHILD_MODEL_HEADER } from '../lib/rpc-child-model-authority'

interface Installation {
  readonly agent: { streamFn: StreamFn }
  readonly original: StreamFn
  readonly wrapper: StreamFn
  readonly controller: AbortController
  readonly owner: object
}
const installed = new WeakMap<object, Installation>()

/** The launcher supplies lease authority; model/extension event input cannot grant it. */
export function createRpcNativeStreamExtension(
  scope: TrustedNativeStreamScope,
  privateRequestHeaders?: (
    ctx: ExtensionContext,
    expectedNativeWrapper: StreamFn
  ) => Readonly<Record<string, string>> | undefined
): {
  extension: ExtensionFactory
  assertInstalled(ctx: ExtensionContext): void
  dispose(): void
} {
  validateNativeStreamScope(scope)
  const owner = {}
  const owned = new Set<Installation>()
  let api: Parameters<ExtensionFactory>[0] | undefined
  let disposed = false
  const session = (ctx: ExtensionContext): AgentSession => {
    integrity(api && !disposed && !scope.signal?.aborted)
    const ref = api.pi.AgentRegistry.global().get(ctx.agent.id)
    const current = ref?.session
    integrity(
      ref?.kind === ctx.agent.kind &&
        current &&
        current.sessionManager === ctx.sessionManager &&
        current.sessionManager.getSessionId() === ctx.sessionManager.getSessionId()
    )
    return current
  }
  const remove = (entry: Installation): void => {
    entry.controller.abort()
    if (entry.agent.streamFn === entry.wrapper) entry.agent.streamFn = entry.original
    if (installed.get(entry.agent) === entry) installed.delete(entry.agent)
    owned.delete(entry)
  }
  const install = (ctx: ExtensionContext): void => {
    const current = session(ctx)
    const previous = installed.get(current.agent)
    if (previous?.owner === owner) {
      integrity(current.agent.streamFn === previous.wrapper)
      return
    }
    let original = current.agent.streamFn
    if (previous) {
      integrity(original === previous.wrapper)
      original = previous.original
      previous.controller.abort()
      installed.delete(current.agent)
    }
    const controller = new AbortController()
    const signal = scope.signal
      ? AbortSignal.any([scope.signal, controller.signal])
      : controller.signal
    const actorHeaders = (): Readonly<Record<string, string>> | undefined => {
      const installation = installed.get(current.agent)
      integrity(
        session(ctx) === current &&
          installation?.owner === owner &&
          installation.wrapper === wrapper &&
          !installation.controller.signal.aborted
      )
      if (ctx.agent.kind === 'main') {
        integrity(scope.isActive() && current.agent.streamFn === wrapper)
        return privateRequestHeaders
          ? privateRequestHeaders(ctx, wrapper)
          : scope.privateRequestHeaders?.()
      }
      integrity(ctx.agent.kind === 'sub' && privateRequestHeaders)
      // The trusted callback verifies the exact profile gate/native original
      // and this child's captured parent before signing its complete binding.
      const headers = privateRequestHeaders(ctx, wrapper)
      const header = headers?.[RPC_CHILD_MODEL_HEADER]
      integrity(typeof header === 'string' && header.length > 0 && header.length <= 8192)
      return headers
    }
    const wrapper = createNativeStreamIntegrityAdapter(original, {
      ...scope,
      signal,
      privateRequestHeaders: actorHeaders,
      isActive: () => {
        if (disposed || controller.signal.aborted || scope.signal?.aborted) return false
        try {
          actorHeaders()
          return true
        } catch {
          return false
        }
      }
    })
    const entry: Installation = { agent: current.agent, original, wrapper, controller, owner }
    current.agent.streamFn = wrapper
    installed.set(current.agent, entry)
    owned.add(entry)
  }
  return {
    extension: (pi) => {
      integrity(!api || api === pi)
      api = pi
      pi.on('session_start', (_event, ctx) => {
        if (!disposed) install(ctx)
      })
      pi.on('session_switch', (_event, ctx) => {
        if (!disposed) install(ctx)
      })
      pi.on('session_shutdown', (_event, ctx) => {
        const ref = pi.pi.AgentRegistry.global().get(ctx.agent.id)
        const entry = ref?.session && installed.get(ref.session.agent)
        if (entry?.owner === owner) remove(entry)
      })
    },
    assertInstalled: (ctx) => {
      const current = session(ctx)
      const entry = installed.get(current.agent)
      integrity(
        entry?.owner === owner &&
          current.agent.streamFn === entry.wrapper &&
          !entry.controller.signal.aborted &&
          (ctx.agent.kind !== 'main' || scope.isActive())
      )
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const entry of owned) remove(entry)
    }
  }
}
