import type { JsonValue, SessionLastRun } from '../../shared/kernel-protocol'

const thinkingLevels = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function projectSessionState(
  sessionId: string,
  value: unknown,
  activeRunId?: string,
  lastRun?: SessionLastRun
): JsonValue {
  const state = isRecord(value) ? value : {}
  const model = isRecord(state.model) ? state.model : undefined
  const messages = Array.isArray(state.messages) ? (state.messages as JsonValue[]) : []
  const cwd = typeof state.cwd === 'string' && state.cwd ? state.cwd : undefined
  if (!cwd) throw new TypeError('Worker session state omitted cwd')
  return {
    sessionId,
    messages,
    ...(model && typeof model.provider === 'string' && typeof model.id === 'string'
      ? { model: { provider: model.provider, id: model.id } }
      : {}),
    ...(typeof state.thinkingLevel === 'string' && thinkingLevels.has(state.thinkingLevel)
      ? { thinkingLevel: state.thinkingLevel }
      : {}),
    cwd,
    ...(activeRunId ? { activeRunId } : {}),
    ...(lastRun ? { lastRun } : {})
  }
}
