import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  SessionManager
} from '@oh-my-pi/pi-coding-agent'
import { proveSavedSession } from '../lib/rpc-session-proof'
import {
  assertVerificationActive,
  parseSessionManifestRequest,
  parseSessionVerificationRequest,
  SessionVerificationError,
  validateVerificationIdentity,
  verificationFailure,
  verificationRecord,
  RPC_SAVED_STATE_COMMAND,
  RPC_CHECKPOINT_COMMAND,
  RPC_MANIFEST_COMMAND,
  RPC_SESSION_MANIFEST_DESCRIPTION,
  RPC_SESSION_MANIFEST_TYPE,
  RPC_SESSION_VERIFICATION_DESCRIPTION,
  RPC_SESSION_VERIFICATION_TYPE,
  SESSION_VERIFICATION_DEFAULT_BUDGETS,
  type SessionVerificationCapability,
  type SessionManifestNotification,
  type SessionManifestRequest,
  type SessionVerificationNotification
} from '../lib/rpc-session-verification-protocol'

async function privateManifest(path: string): Promise<void> {
  const stat = await lstat(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    verificationFailure('FILE_INVALID')
}

async function publishSessionManifest(
  capability: SessionVerificationCapability,
  request: SessionManifestRequest
): Promise<string> {
  assertVerificationActive(capability)
  const target = posix.join(capability.directory, 'manifest.json')
  const content = Buffer.from(`${JSON.stringify(request.manifest)}\n`)
  if (content.length > 16 * 1024) verificationFailure('VERIFICATION_LIMIT')
  const matches = async (): Promise<boolean> => {
    try {
      await privateManifest(target)
      const existing = await readFile(target)
      if (existing.length > 16 * 1024) verificationFailure('FILE_INVALID')
      const parsed: unknown = JSON.parse(existing.toString('utf8'))
      return (
        verificationRecord(parsed) &&
        Object.keys(parsed).sort().join(',') === Object.keys(request.manifest).sort().join(',') &&
        Object.keys(request.manifest).every(
          (key) => parsed[key] === request.manifest[key as keyof typeof request.manifest]
        )
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      if (error instanceof SyntaxError) verificationFailure('FILE_INVALID')
      throw error
    }
  }
  try {
    if (await matches()) return createHash('sha256').update(content).digest('hex')
  } catch (error) {
    if (error instanceof SessionVerificationError) throw error
    verificationFailure('FILE_INVALID')
  }
  try {
    await lstat(target)
    verificationFailure('IDENTITY_MISMATCH')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = posix.join(capability.directory, `.manifest-${request.requestId}.tmp`)
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
    await privateManifest(temporary)
    assertVerificationActive(capability)
    try {
      await lstat(target)
      verificationFailure('IDENTITY_MISMATCH')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(temporary, target)
    await privateManifest(target)
    return createHash('sha256').update(content).digest('hex')
  } catch (error) {
    if (error instanceof SessionVerificationError) throw error
    verificationFailure('PERSISTENCE_FAILED')
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

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
  pi.registerCommand(RPC_MANIFEST_COMMAND, {
    description: RPC_SESSION_MANIFEST_DESCRIPTION,
    handler: async (args, ctx) => {
      const request = parseSessionManifestRequest(args, capability)
      let notification: SessionManifestNotification
      try {
        if (proving) verificationFailure('SESSION_BUSY')
        const captured = capture(ctx)
        if (
          captured.id !== request.manifest.ompSessionId ||
          captured.path !== posix.join(capability.journals, request.manifest.journalBasename)
        )
          verificationFailure('IDENTITY_MISMATCH')
        proving = true
        try {
          const sha256 = await publishSessionManifest(capability, request)
          const current = capture(ctx)
          if (
            current.ref !== captured.ref ||
            current.session !== captured.session ||
            current.manager !== captured.manager ||
            current.id !== captured.id ||
            current.path !== captured.path ||
            current.leaf !== captured.leaf
          )
            verificationFailure('IDENTITY_MISMATCH')
          notification = { type: RPC_SESSION_MANIFEST_TYPE, request, sha256 }
        } finally {
          proving = false
        }
      } catch (error) {
        notification = {
          type: RPC_SESSION_MANIFEST_TYPE,
          request,
          error: error instanceof SessionVerificationError ? error.code : 'PERSISTENCE_FAILED'
        }
      }
      ctx.ui.notify(JSON.stringify(notification), 'info')
    }
  })
}
