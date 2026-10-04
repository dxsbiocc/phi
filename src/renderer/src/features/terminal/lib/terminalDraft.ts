import type { TerminalCommandDraft } from '../../../../../shared/terminalTypes'

export const TERMINAL_DRAFT_SELECTION_MAX_BYTES = 16 * 1024
export const TERMINAL_DRAFT_STORE_MAX_ENTRIES = 32
export const TERMINAL_DRAFT_STORE_MAX_AGE_MS = 30 * 60 * 1_000

export interface TerminalDraftRetentionEntry {
  terminalId: string
  workspaceKey: string
  lastTouchedAt: number
}

export interface TerminalDraftLiveWorkspace {
  workspaceKey: string
  terminalIds: ReadonlySet<string>
}

export interface TerminalLineInputState {
  printableCharacters: number
}

export const EMPTY_TERMINAL_LINE_INPUT: TerminalLineInputState = {
  printableCharacters: 0
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function terminalDraftSelectionBoundary(value: string): {
  byteLength: number
  includedCharacters: number
  truncated: boolean
} {
  const byteLength = utf8ByteLength(value)
  if (byteLength <= TERMINAL_DRAFT_SELECTION_MAX_BYTES) {
    return { byteLength, includedCharacters: value.length, truncated: false }
  }

  let bytes = 0
  let includedCharacters = 0
  for (const character of value) {
    const nextBytes = utf8ByteLength(character)
    if (bytes + nextBytes > TERMINAL_DRAFT_SELECTION_MAX_BYTES) break
    bytes += nextBytes
    includedCharacters += character.length
  }
  return { byteLength, includedCharacters, truncated: true }
}

export function substituteTerminalDraftInputs(
  source: string,
  requiredInputs: readonly TerminalCommandDraft['requiredInputs'][number][],
  values: Readonly<Record<string, string>>
): string {
  let result = source
  for (const input of requiredInputs) {
    result = result.split(`<${input.name}>`).join(values[input.name] ?? '')
  }
  return result
}

export function missingTerminalDraftInputs(
  requiredInputs: readonly TerminalCommandDraft['requiredInputs'][number][],
  values: Readonly<Record<string, string>>
): string[] {
  return requiredInputs
    .filter((input) => !(values[input.name] ?? '').trim())
    .map((input) => input.name)
}

export function terminalDraftErrorMessage(message: string): string {
  return message.includes('请先配置模型') ? '请先在设置中配置模型' : message
}

export function terminalDraftRetentionRemovals(
  entries: readonly TerminalDraftRetentionEntry[],
  options: { now: number; liveWorkspace?: TerminalDraftLiveWorkspace }
): string[] {
  const removals = new Set<string>()
  const oldestAllowed = options.now - TERMINAL_DRAFT_STORE_MAX_AGE_MS

  for (const entry of entries) {
    if (entry.lastTouchedAt <= oldestAllowed) removals.add(entry.terminalId)
    if (
      options.liveWorkspace &&
      entry.workspaceKey === options.liveWorkspace.workspaceKey &&
      !options.liveWorkspace.terminalIds.has(entry.terminalId)
    ) {
      removals.add(entry.terminalId)
    }
  }

  const retained = entries
    .filter((entry) => !removals.has(entry.terminalId))
    .sort((left, right) => left.lastTouchedAt - right.lastTouchedAt)
  const excess = retained.length - TERMINAL_DRAFT_STORE_MAX_ENTRIES
  for (let index = 0; index < excess; index += 1) {
    removals.add(retained[index].terminalId)
  }

  return [...removals]
}

function isCsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e
}

/**
 * Tracks whether printable keyboard input remains on the current terminal line.
 * This is deliberately conservative: Enter, Ctrl+C, and Ctrl+U reset the state,
 * backspace removes one observed character, and terminal escape sequences do not
 * count as printable input.
 */
export function updateTerminalLineInput(
  previous: TerminalLineInputState,
  data: string
): TerminalLineInputState {
  let printableCharacters = previous.printableCharacters

  for (let index = 0; index < data.length;) {
    const code = data.charCodeAt(index)
    if (code === 0x1b) {
      index += 1
      if (data.charCodeAt(index) === 0x5b) {
        index += 1
        while (index < data.length && !isCsiFinalByte(data.charCodeAt(index))) index += 1
        if (index < data.length) index += 1
      } else if (index < data.length) {
        index += 1
      }
      continue
    }
    if (code === 0x0a || code === 0x0d || code === 0x03 || code === 0x15) {
      printableCharacters = 0
      index += 1
      continue
    }
    if (code === 0x08 || code === 0x7f) {
      printableCharacters = Math.max(0, printableCharacters - 1)
      index += 1
      continue
    }

    const character = String.fromCodePoint(data.codePointAt(index) ?? code)
    if (code >= 0x20 && code !== 0x7f) printableCharacters += 1
    index += character.length
  }

  return { printableCharacters }
}

export function isTerminalLineDirty(state: TerminalLineInputState): boolean {
  return state.printableCharacters > 0
}
