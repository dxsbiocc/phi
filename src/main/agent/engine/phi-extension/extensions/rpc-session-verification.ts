import { realpathSync } from 'node:fs'
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  SessionManager
} from '@oh-my-pi/pi-coding-agent'
import { proveSavedSession } from '../lib/rpc-session-proof'
import {
  assertVerificationActive,
  parseSessionVerificationRequest,
  SessionVerificationError,
  validateVerificationIdentity,
  verificationFailure,
  RPC_SAVED_STATE_COMMAND,
  RPC_CHECKPOINT_COMMAND,
  RPC_SESSION_VERIFICATION_DESCRIPTION,
  RPC_SESSION_VERIFICATION_TYPE,
  SESSION_VERIFICATION_DEFAULT_BUDGETS,
  type SessionVerificationCapability,
  type SessionVerificationNotification
} from '../lib/rpc-session-verification-protocol'

/** Trusted launcher injects this capability; commands may select only a bounded basename/id. */
export function registerRpcSessionVerification(
  pi: ExtensionAPI,
  supplied: SessionVerificationCapability
): void {
  validateVerificationIdentity(supplied)
  const budgets = Object.freeze({ ...(supplied.budgets ?? SESSION_VERIFICATION_DEFAULT_BUDGETS) })
  if (
    Object.keys(budgets).sort().join(',') !==
      'entries,hydratedBytes,journalBytes,nodes,references' ||
    Object.values(budgets).some((value) => !Number.isSafeInteger(value) || value < 1) ||
    budgets.journalBytes > 512 * 1024 * 1024 ||
    budgets.hydratedBytes > 1024 * 1024 * 1024 ||
    budgets.entries > 1_000_000 ||
    budgets.nodes > 4_000_000 ||
    budgets.references > 1_000_000
  )
    verificationFailure('VERIFICATION_LIMIT')
  const capability = Object.freeze({ ...supplied, budgets })
  let proving = false
  const capture = (
    ctx: ExtensionContext
  ): {
    ref: object
    session: AgentSession
    manager: SessionManager
    id: string
    path: string | undefined
    leaf: string | null
  } => {
    assertVerificationActive(capability)
    const ref = pi.pi.AgentRegistry.global().get(ctx.agent.id)
    const session = ref?.session
    // A local slash command itself is an admitted submission. The launcher gate
    // and Node get_state check exclude other submissions and scheduled goals.
    if (
      !ref ||
      !session ||
      session.sessionManager !== ctx.sessionManager ||
      realpathSync(ctx.cwd) !== capability.projectRoot
    )
      verificationFailure('IDENTITY_MISMATCH')
    if (
      !ctx.isIdle() ||
      session.isStreaming ||
      session.isCompacting ||
      session.queuedMessageCount !== 0 ||
      session.hasPendingAsyncWork()
    )
      verificationFailure('SESSION_BUSY')
    return {
      ref,
      session,
      manager: session.sessionManager,
      id: session.sessionManager.getSessionId(),
      path: session.sessionManager.getSessionFile(),
      leaf: session.sessionManager.getLeafId()
    }
  }
  for (const action of ['saved', 'checkpoint'] as const) {
    pi.registerCommand(action === 'saved' ? RPC_SAVED_STATE_COMMAND : RPC_CHECKPOINT_COMMAND, {
      description: RPC_SESSION_VERIFICATION_DESCRIPTION,
      handler: async (args, ctx) => {
        const request = parseSessionVerificationRequest(args, capability, action)
        let notification: SessionVerificationNotification
        try {
          if (proving) verificationFailure('SESSION_BUSY')
          const captured = capture(ctx)
          proving = true
          try {
            let checkpointLeaf: string | null = captured.leaf
            if (action === 'checkpoint') {
              if (
                captured.manager.getSessionId() !== request.ompSessionId ||
                captured.manager.getSessionFile() !==
                  `${capability.journals}/${request.journalBasename}`
              )
                verificationFailure('IDENTITY_MISMATCH')
              try {
                await captured.session.flushToDisk()
              } catch {
                verificationFailure('PERSISTENCE_FAILED')
              }
              // A real flush may append pending Bash output. Bind the fresh
              // checkpoint to that post-flush state, never the pre-flush leaf.
              checkpointLeaf = captured.manager.getLeafId()
            }
            const assertSame = (): void => {
              const current = capture(ctx)
              if (
                current.ref !== captured.ref ||
                current.session !== captured.session ||
                current.manager !== captured.manager ||
                current.id !== captured.id ||
                current.path !== captured.path ||
                (action === 'saved' && current.leaf !== captured.leaf)
              )
                verificationFailure('IDENTITY_MISMATCH')
            }
            assertSame()
            const proof = await proveSavedSession(
              pi.pi,
              capability,
              request,
              action === 'checkpoint' ? captured.manager : undefined
            )
            assertSame()
            if (
              action === 'checkpoint' &&
              (captured.manager.getLeafId() !== checkpointLeaf || proof.leafId !== checkpointLeaf)
            )
              verificationFailure('IDENTITY_MISMATCH')
            notification = { type: RPC_SESSION_VERIFICATION_TYPE, request, proof }
          } finally {
            proving = false
          }
        } catch (error) {
          notification = {
            type: RPC_SESSION_VERIFICATION_TYPE,
            request,
            error: error instanceof SessionVerificationError ? error.code : 'FILE_INVALID'
          }
        }
        ctx.ui.notify(JSON.stringify(notification), 'info')
      }
    })
  }
}
