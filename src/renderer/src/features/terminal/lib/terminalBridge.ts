import type { TerminalRendererBridge } from '../../../../../shared/terminalTypes'

const TERMINAL_BRIDGE_METHODS = [
  'list',
  'create',
  'attach',
  'input',
  'resize',
  'ack',
  'close',
  'generateDraft',
  'cancelDraft',
  'submitDraft',
  'onEvent'
] as const satisfies readonly (keyof TerminalRendererBridge)[]

export function isTerminalBridgeAvailable(value: unknown): value is TerminalRendererBridge {
  if (typeof value !== 'object' || value === null) return false

  return TERMINAL_BRIDGE_METHODS.every(
    (method) => typeof (value as Record<string, unknown>)[method] === 'function'
  )
}
