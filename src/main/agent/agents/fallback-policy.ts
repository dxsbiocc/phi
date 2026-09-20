import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import type { PhiAgentDefinition } from './definition'
import type { AgentRunRegistry } from './registry'

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

/** Evaluates only declared resource matches; unrelated generic tool use is untouched. */
export function evaluateSpecialistFallback(
  call: SpecialistToolCall,
  agents: readonly PhiAgentDefinition[],
  registry: AgentRunRegistry
): SpecialistFallbackDecision {
  const input = serializedInput(call.input)
  const owner = agents.find(
    (agent) =>
      agent.delegationMode === 'required-first' &&
      agent.fallback?.tools.includes(call.toolName) &&
      agent.fallback.match.some((target) => input.includes(target.toLowerCase()))
  )
  if (!owner?.fallback) return { allowed: true }

  const readiness = registry.fallbackReadiness(owner.name, owner.fallback.afterFailures)
  if (readiness.allowed) return { allowed: true, agent: owner.name }

  return {
    allowed: false,
    agent: owner.name,
    reason:
      readiness.reason ??
      `${owner.name} owns this target. Delegate to ${owner.name} first; use ${call.toolName} only after ${owner.fallback.afterFailures} not-found, blocked, or failed specialist attempt(s).`
  }
}

/** Blocks only premature matching fallback calls; normal shell/eval work still runs. */
export function createSpecialistFallbackExtension(
  agents: readonly PhiAgentDefinition[],
  registry: AgentRunRegistry
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const decision = evaluateSpecialistFallback(
        { toolName: event.toolName, input: event.input },
        agents,
        registry
      )
      return decision.allowed ? undefined : { block: true, reason: decision.reason }
    })
  }
}
