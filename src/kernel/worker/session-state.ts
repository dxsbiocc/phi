import type { JsonValue, SessionLastRun } from '../../shared/kernel-protocol'
import type { SessionCreateParams } from '../../shared/kernel-protocol'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { makeProtocolError } from '../protocol/errors'

const thinkingLevels = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function hasTrustedSessionResources(params: Partial<SessionCreateParams>): boolean {
  return (
    params.resourceOptions !== undefined ||
    params.phiAgents !== undefined ||
    params.personaMarkdown !== undefined ||
    params.projectBound !== undefined ||
    params.memory !== undefined ||
    params.contextFiles !== undefined ||
    params.mcpServers !== undefined ||
    params.desktopMcp !== undefined ||
    params.environment !== undefined
  )
}

export async function assertExistingAbsoluteDirectory(cwd: string): Promise<void> {
  if (isAbsolute(cwd)) {
    try {
      if ((await stat(cwd)).isDirectory()) return
    } catch {
      // The protocol exposes one result for missing and non-directory paths.
    }
  }
  throw makeProtocolError('INVALID_PARAMS', 'Session cwd must be an existing absolute directory.')
}

export function projectSessionState(
  sessionId: string,
  value: unknown,
  activeRunId?: string,
  lastRun?: SessionLastRun
): JsonValue {
  const state = record(value) ?? {}
  const model = record(state.model)
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
