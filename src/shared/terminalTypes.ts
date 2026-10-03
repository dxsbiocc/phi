export const TERMINAL_MIN_COLS = 20
export const TERMINAL_MAX_COLS = 500
export const TERMINAL_MIN_ROWS = 5
export const TERMINAL_MAX_ROWS = 200
export const TERMINAL_MAX_INPUT_BYTES = 64 * 1024
export const TERMINAL_RING_BUFFER_BYTES = 2 * 1024 * 1024
export const TERMINAL_CREDIT_WINDOW_BYTES = 512 * 1024

export type TerminalWorkspaceRef =
  { kind: 'project'; projectId: string } | { kind: 'ordinary'; sessionId?: string }

export type TerminalState = 'starting' | 'open' | 'closing' | 'exited' | 'failed'

export interface TerminalSnapshot {
  terminalId: string
  workspaceKey: string
  title: string
  host: 'local'
  initialCwd: string
  shell: string
  state: TerminalState
  createdAt: string
  cols: number
  rows: number
  exitCode?: number
  message?: string
}

export type TerminalEvent =
  | { type: 'data'; terminalId: string; seq: number; data: string }
  | { type: 'state'; terminalId: string; snapshot: TerminalSnapshot }
  | { type: 'gap'; terminalId: string; resumeSeq: number }

export interface TerminalCommandDraft {
  draftId: string
  terminalId: string
  workspaceKey: string
  source: string
  explanation: string
  requiredInputs: Array<{ name: string; description: string }>
}
