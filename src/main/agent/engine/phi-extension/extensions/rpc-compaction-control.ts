import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSession, ExtensionContext, ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import type { RpcRuntimeConfig } from '../lib/rpc-runtime-config'
import {
  compactionPolicy,
  compactionRecord,
  compactionRequest,
  RPC_COMPACTION_COMMAND,
  RPC_COMPACTION_DESCRIPTION,
  type RpcCompactionNotification,
  type RpcCompactionPolicy,
  type RpcCompactionSummary
} from '../lib/rpc-compaction-control'

/** Local commands only: model/tool input never supplies this extension's generation identity. */
export function createRpcCompactionExtension(
  config: RpcRuntimeConfig,
  signal: AbortSignal
): {
  extension: ExtensionFactory
  isActive(): boolean
} {
  const policyPath = join(config.generationDirectory, 'startup-policy.json')
  const bytes = (): string => readFileSync(policyPath, 'utf8')
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
  let initial: string
  try {
    initial = bytes()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { extension: () => {}, isActive: () => false }
  }
  const startup: unknown = JSON.parse(initial)
  if (!compactionRecord(startup) || startup.compaction === undefined)
    return { extension: () => {}, isActive: () => false }
  const publishedPolicy = (document: Record<string, unknown>): RpcCompactionPolicy => {
    const values = document.compaction
    if (!compactionRecord(values) || values.modelThresholdsEnabled !== false)
      throw new Error('Ambiguous model-specific compaction policy')
    const plain = { ...values }
    delete plain.modelThresholdsEnabled
    return compactionPolicy(plain)
  }
  publishedPolicy(startup)
  const publication = hash(initial)
  const confirmed = new WeakMap<AgentSession, { policy: RpcCompactionPolicy; revision: number }>()
  let busy = false,
    compacting = false
  let api: Parameters<ExtensionFactory>[0] | undefined
  const actual = (ctx: ExtensionContext): AgentSession => {
    signal.throwIfAborted()
    const ref = api?.pi.AgentRegistry.global().get(ctx.agent.id),
      session = ref?.session
    if (
      ref?.kind !== 'main' ||
      ctx.agent.kind !== 'main' ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      realpathSync(ctx.cwd) !== config.projectRoot ||
      !session ||
      session.sessionManager !== ctx.sessionManager ||
      session.isCompacting ||
      session.isStreaming ||
      session.sessionId !== ctx.sessionManager.getSessionId()
    )
      throw new Error('Compaction requires the owned idle session')
    return session
  }
  const readPolicy = async (
    ctx: ExtensionContext,
    session: AgentSession
  ): Promise<RpcCompactionPolicy> => {
    const assertCurrent = (): void => {
      if (actual(ctx) !== session || hash(bytes()) !== publication)
        throw new Error('Compaction settings publication changed')
      const files = session.settings.getConfigFiles()
      if (files.length !== 1 || realpathSync(files[0]) !== policyPath)
        throw new Error('Compaction requires one owned settings overlay')
    }
    assertCurrent()
    // Drain a possibly earlier watch reload before starting this strict synchronized read.
    await session.settings.reloadFromDisk()
    assertCurrent()
    await session.settings.reloadFromDisk()
    assertCurrent()
    const revision = session.settings.revision
    const document: unknown = JSON.parse(bytes())
    if (!compactionRecord(document)) throw new Error('Compaction settings overlay is invalid')
    const base = publishedPolicy(document)
    const layer = session.settings.overlayLayers().overrides
    if (Object.hasOwn(layer, 'compaction') && !compactionRecord(layer.compaction))
      throw new Error('Ambiguous compaction override')
    const overrides = compactionRecord(layer.compaction) ? layer.compaction : {}
    if (
      Object.keys(overrides).some(
        (key) => !['enabled', 'thresholdPercent', 'thresholdTokens', 'methodOrder'].includes(key)
      )
    )
      throw new Error('Unsupported runtime compaction override')
    const values: Record<string, unknown> = { ...base }
    for (const key of ['enabled', 'thresholdPercent', 'thresholdTokens', 'methodOrder'])
      if (Object.hasOwn(overrides, key)) values[key] = overrides[key]
    const effective = compactionPolicy(values)
    if (
      session.autoCompactionEnabled !== (effective.enabled && effective.methodOrder.length > 0) ||
      session.settings.revision !== revision
    )
      throw new Error('Compaction settings were not confirmed by the owned SDK session')
    assertCurrent()
    return effective
  }
  return {
    isActive: () => compacting && !signal.aborted,
    extension: (pi) => {
      api = pi
      pi.registerCommand(RPC_COMPACTION_COMMAND, {
        description: RPC_COMPACTION_DESCRIPTION,
        handler: async (args, ctx) => {
          const request = compactionRequest(JSON.parse(args))
          if (
            busy ||
            request.nonce !== config.nonce ||
            request.phiSessionId !== config.phiSessionId ||
            request.generation !== config.generation
          )
            throw new Error('Compaction generation is unavailable')
          const session = actual(ctx)
          if (
            session.sessionId !== request.ompSessionId ||
            session.sessionFile !== request.journalPath
          )
            throw new Error('Compaction journal identity changed')
          if (request.operation === 'settings') {
            busy = true
            try {
              const policy = await readPolicy(ctx, session)
              if (JSON.stringify(policy) !== JSON.stringify(request.expectedPolicy))
                throw new Error('Compaction policy differs from the trusted desktop')
              confirmed.set(session, { policy, revision: session.settings.revision })
              const notification: RpcCompactionNotification = {
                ...request,
                type: 'phi_rpc_compaction_control',
                policy
              }
              ctx.ui.notify(JSON.stringify(notification), 'info')
            } finally {
              busy = false
            }
            return
          }
          const cached = confirmed.get(session)
          if (
            !cached ||
            cached.revision !== session.settings.revision ||
            hash(bytes()) !== publication ||
            JSON.stringify(cached.policy) !== JSON.stringify(request.expectedPolicy)
          )
            throw new Error('Compaction requires a current confirmed policy')
          busy = true
          compacting = true
          let summary: RpcCompactionSummary | undefined, failed: Error | undefined
          // Return this local command immediately; RPC abort must remain reachable during summarization.
          const operation = ctx.compact({
            suppressContinuation: true,
            onComplete: (result) => {
              const tokensAfter = ctx.getContextUsage()?.tokens
              if (
                typeof result.summary !== 'string' ||
                !result.summary ||
                !Number.isFinite(result.tokensBefore) ||
                result.tokensBefore < 0
              ) {
                failed = new Error('Invalid compaction summary')
                return
              }
              summary = {
                summary: result.summary,
                tokensBefore: result.tokensBefore,
                ...(result.shortSummary ? { shortSummary: result.shortSummary } : {}),
                ...(typeof tokensAfter === 'number' ? { tokensAfter } : {})
              }
            },
            onError: (error) => {
              failed = error
            }
          })
          void operation
            .then(() => {
              if (!summary || failed || actual(ctx) !== session)
                throw new Error('Compaction did not produce a confirmed summary')
              busy = false
              compacting = false
              const notification: RpcCompactionNotification = {
                ...request,
                type: 'phi_rpc_compaction_control',
                policy: cached.policy,
                summary
              }
              ctx.ui.notify(JSON.stringify(notification), 'info')
            })
            .catch(() => {
              busy = false
              compacting = false
              if (!signal.aborted)
                ctx.ui.notify(
                  JSON.stringify({
                    ...request,
                    type: 'phi_rpc_compaction_control',
                    policy: cached.policy,
                    error: 'COMPACTION_FAILED'
                  }),
                  'info'
                )
            })
            .finally(() => {
              busy = false
              compacting = false
            })
        }
      })
    }
  }
}
