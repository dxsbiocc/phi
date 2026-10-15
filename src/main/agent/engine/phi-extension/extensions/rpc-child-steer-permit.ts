import type { AgentSession } from '@oh-my-pi/pi-coding-agent'
import {
  sameRpcChildScope,
  validateRpcChildScope,
  type RpcChildScope
} from '../lib/rpc-child-protocol'

export interface RpcChildSteerPermits {
  hasPending(session: AgentSession): boolean
  grant(session: AgentSession, scope: RpcChildScope, controlId: string, message: string): () => void
  revoke(session: AgentSession): void
  dispose(): void
  consume(
    session: AgentSession,
    scope: RpcChildScope,
    prompt: string,
    images?: readonly unknown[]
  ): boolean
}

/** Factory-private permits are issued only after the authenticated exact-child control gate. */
export function createRpcChildSteerPermits(): RpcChildSteerPermits {
  const pending = new Map<
    AgentSession,
    { scope: RpcChildScope; controlId: string; message: string }
  >()
  let disposed = false
  return Object.freeze({
    hasPending: (session: AgentSession): boolean => pending.has(session),
    revoke: (session: AgentSession): void => {
      pending.delete(session)
    },
    dispose: (): void => {
      disposed = true
      pending.clear()
    },
    grant(session, input, controlId, message): () => void {
      const scope = validateRpcChildScope(input)
      if (disposed || pending.has(session) || !controlId || !message.trim())
        throw new Error('Child steer submission is already pending')
      const permit = Object.freeze({ scope, controlId, message })
      pending.set(session, permit)
      return () => {
        if (pending.get(session) === permit) pending.delete(session)
      }
    },
    consume(session, scope, prompt, images): boolean {
      const permit = pending.get(session)
      if (
        !permit ||
        !sameRpcChildScope(scope, permit.scope) ||
        prompt !== permit.message ||
        (images?.length ?? 0) !== 0
      )
        return false
      pending.delete(session)
      return true
    }
  })
}
