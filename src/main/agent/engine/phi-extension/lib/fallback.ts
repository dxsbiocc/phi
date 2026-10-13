import type { PhiExtensionAgentConfig, PhiExtensionFallbackReadiness } from '../host'

export interface SpecialistToolCall {
  toolName: string
  input: unknown
}

export interface SpecialistFallbackDecision {
  allowed: boolean
  agent?: string
  reason?: string
}

function serializedInput(value: unknown): string {
  try {
    return JSON.stringify(value).toLowerCase()
  } catch {
    return String(value).toLowerCase()
  }
}

export function evaluateSpecialistFallback(
  call: SpecialistToolCall,
  agents: readonly PhiExtensionAgentConfig[],
  fallbackReadiness: (agent: string, afterFailures: number) => PhiExtensionFallbackReadiness
): SpecialistFallbackDecision {
  const input = serializedInput(call.input)
  const owner = agents.find(
    (agent) =>
      agent.delegationMode === 'required-first' &&
      agent.fallback?.tools.includes(call.toolName) &&
      agent.fallback.match.some((target) => input.includes(target.toLowerCase()))
  )
  if (!owner?.fallback) return { allowed: true }

  const readiness = fallbackReadiness(owner.name, owner.fallback.afterFailures)
  if (readiness.allowed) return { allowed: true, agent: owner.name }

  return {
    allowed: false,
    agent: owner.name,
    reason:
      readiness.reason ??
      `${owner.name} owns this target. Delegate to ${owner.name} first; use ${call.toolName} only after ${owner.fallback.afterFailures} not-found, blocked, or failed specialist attempt(s).`
  }
}
