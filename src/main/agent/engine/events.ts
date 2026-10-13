import { type CreateAgentSessionResult } from '@oh-my-pi/pi-coding-agent'

export function contextTokensNow(session: CreateAgentSessionResult['session']): number | undefined {
  try {
    const tokens = session.getContextUsage()?.tokens
    return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined
  } catch {
    return undefined
  }
}

export function compactedTokensAfter(
  session: CreateAgentSessionResult['session']
): number | undefined {
  try {
    const leaf = session.sessionManager.getLeafEntry()
    if (
      leaf?.type === 'compaction' &&
      typeof leaf.tokensAfter === 'number' &&
      Number.isFinite(leaf.tokensAfter) &&
      leaf.tokensAfter >= 0
    ) {
      return leaf.tokensAfter
    }
    return contextTokensNow(session)
  } catch {
    return undefined
  }
}

export function translateOmpEvent(
  event: Parameters<Parameters<CreateAgentSessionResult['session']['subscribe']>[0]>[0],
  session: CreateAgentSessionResult['session']
): unknown {
  const tokensAfter =
    event.type === 'auto_compaction_end' && !event.aborted && !event.skipped
      ? event.action === 'shake'
        ? contextTokensNow(session)
        : compactedTokensAfter(session)
      : undefined
  return tokensAfter === undefined ? event : { ...event, tokensAfter }
}
