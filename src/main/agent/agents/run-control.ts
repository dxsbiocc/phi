import { isFinalAgentRunState, type AgentRunRegistry } from './registry'

/**
 * A delegation card in the chat steers or stops the run it shows. The request
 * arrives in the agent worker addressed to one session; this is what that
 * session's run registry does with it. Errors are the messages the card shows.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(params: unknown, key: string): string {
  const value = isRecord(params) ? params[key] : undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required parameter: ${key}`)
  }
  return value.trim()
}

export async function controlAgentRun(
  registry: AgentRunRegistry | undefined,
  action: 'steer' | 'stop',
  params: unknown
): Promise<{ ok: true }> {
  const runId = requireString(params, 'runId')
  const message = action === 'steer' ? requireString(params, 'message') : undefined
  // The worker forgets a session's runs when it goes away, e.g. after Phi was restarted.
  if (!registry) throw new Error(`Run ${runId} is no longer running.`)

  if (action === 'steer') {
    await registry.steer(runId, message as string)
    return { ok: true }
  }

  const run = registry.get(runId)
  if (!run) throw new Error(`Unknown run: ${runId}`)
  if (isFinalAgentRunState(run.state)) {
    throw new Error(`Run ${runId} (${run.agent}) has already finished.`)
  }
  registry.stop(runId)
  return { ok: true }
}
