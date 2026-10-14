import type { RuntimeModel, RuntimeSelectionControl, ThinkingLevel } from '../types'
import type { RpcConnection } from './connection'

export interface RuntimeInitialSelection extends RuntimeSelectionControl {
  readonly signal: AbortSignal
  readonly model: RuntimeModel
  readonly thinkingLevel: ThinkingLevel | 'off'
}

const LEVELS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Match the existing Phi picker; the remote SDK must independently confirm its effective value. */
export function selectionThinking(
  model: RuntimeModel,
  desired: ThinkingLevel | undefined,
  explicit = false
): { phi: ThinkingLevel | undefined; rpc: ThinkingLevel | 'off' } {
  if (explicit && desired && model.reasoning && LEVELS.includes(desired)) {
    if (model.thinkingLevelMap?.[desired] === null)
      throw new Error('Unsupported thinking level for selected model')
    // The provider lineage can support levels absent from the desktop metadata map.
    // Validate against the actual SDK before retiring the current generation.
    return { phi: desired, rpc: desired }
  }
  const supported = model.reasoning
    ? LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level]
        return mapped !== null && (!['xhigh', 'max'].includes(level) || mapped !== undefined)
      })
    : []
  if (!supported.length) {
    if (explicit && desired !== undefined)
      throw new Error('Unsupported thinking level for selected model')
    return { phi: undefined, rpc: 'off' }
  }
  if (desired && supported.includes(desired)) return { phi: desired, rpc: desired }
  if (explicit) throw new Error('Unsupported thinking level for selected model')
  // Extended tiers require a supported saved/desired choice, never an automatic fallback.
  const regular = supported.filter((level) => level !== 'xhigh' && level !== 'max')
  const level = regular.includes('high') ? 'high' : regular.at(-1)
  return { phi: level, rpc: level ?? 'off' }
}

export async function confirmInitialThinking(
  connection: RpcConnection,
  model: Pick<RuntimeModel, 'provider' | 'id'>,
  selection: RuntimeInitialSelection,
  signal: AbortSignal
): Promise<void> {
  const current = (): void => {
    signal.throwIfAborted()
    selection.assertCurrent()
  }
  current()
  const available = await connection.request<{ levels?: unknown }>({
    type: 'get_available_thinking_levels'
  })
  current()
  if (!Array.isArray(available.levels) || !available.levels.includes(selection.thinkingLevel))
    throw new Error('Remote SDK does not support the requested thinking level')
  await connection.request({ type: 'set_thinking_level', level: selection.thinkingLevel })
  current()
  const state = await connection.request<{
    model?: { provider?: unknown; id?: unknown }
    thinkingLevel?: unknown
  }>({ type: 'get_state' })
  current()
  if (
    state.model?.provider !== model.provider ||
    state.model?.id !== model.id ||
    state.thinkingLevel !== selection.thinkingLevel
  )
    throw new Error('Remote SDK did not confirm the requested model/thinking selection')
}
