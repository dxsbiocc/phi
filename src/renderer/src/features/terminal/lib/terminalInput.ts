import { TERMINAL_MAX_INPUT_BYTES } from '../../../../../shared/terminalTypes'

export type TerminalKeyAction = 'process' | 'copy' | 'paste' | 'clear' | 'ignore'

export interface TerminalKeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
}

const encoder = new TextEncoder()

export function terminalKeyAction(
  event: TerminalKeyEvent,
  hasSelection: boolean
): TerminalKeyAction {
  const key = event.key.toLowerCase()

  if (event.metaKey) {
    if (key === 'c') return hasSelection ? 'copy' : 'ignore'
    if (key === 'v') return 'paste'
    if (key === 'k') return 'clear'
    return 'ignore'
  }

  // Ctrl+C remains xterm input so the PTY receives ETX. In particular, it is
  // deliberately distinct from the macOS Cmd+C selection shortcut above.
  if (event.ctrlKey && key === 'c') return 'process'
  return 'process'
}

export function isMultilinePaste(text: string): boolean {
  return /[\r\n]/u.test(text)
}

export function wrapBracketedPaste(text: string, bracketedPasteMode: boolean): string {
  return bracketedPasteMode ? `\u001b[200~${text}\u001b[201~` : text
}

export function terminalInputByteLength(text: string): number {
  return encoder.encode(text).byteLength
}

export function isTerminalInputWithinLimit(text: string): boolean {
  return terminalInputByteLength(text) <= TERMINAL_MAX_INPUT_BYTES
}
