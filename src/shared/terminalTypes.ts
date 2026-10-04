export const TERMINAL_MIN_COLS = 20
export const TERMINAL_MAX_COLS = 500
export const TERMINAL_MIN_ROWS = 5
export const TERMINAL_MAX_ROWS = 200
export const TERMINAL_MAX_INPUT_BYTES = 64 * 1024
export const TERMINAL_RING_BUFFER_BYTES = 2 * 1024 * 1024
export const TERMINAL_CREDIT_WINDOW_BYTES = 512 * 1024

export type TerminalWorkspaceRef = { kind: 'project'; projectId: string } | { kind: 'ordinary' }

export type TerminalErrorCode =
  | 'not_found'
  | 'remote_unsupported'
  | 'directory_missing'
  | 'limit_reached'
  | 'busy'
  | 'invalid'
  | 'not_open'
  | 'unavailable'
  | 'unsupported_platform'

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
  | { type: 'data'; terminalId: string; epoch: number; seq: number; data: string }
  | {
      type: 'gap'
      terminalId: string
      epoch: number
      fromSeq: number
      toSeq: number
      droppedBytes: number
    }
  | { type: 'state'; snapshot: TerminalSnapshot }

export interface TerminalAttachResult {
  epoch: number
  snapshot: TerminalSnapshot
  records: Array<{ seq: number; data: string }>
  gap?: { fromSeq: number; toSeq: number; droppedBytes: number }
  nextSeq: number
}

export type TerminalResult<T> =
  { ok: true; value: T } | { ok: false; code: TerminalErrorCode; message: string }

export interface TerminalRendererBridge {
  list(ref: TerminalWorkspaceRef): Promise<TerminalResult<TerminalSnapshot[]>>
  create(input: {
    workspace: TerminalWorkspaceRef
    cols: number
    rows: number
    requestId: string
  }): Promise<TerminalResult<TerminalSnapshot>>
  attach(terminalId: string): Promise<TerminalResult<TerminalAttachResult>>
  input(terminalId: string, data: string): Promise<TerminalResult<void>>
  resize(terminalId: string, cols: number, rows: number): Promise<TerminalResult<void>>
  ack(terminalId: string, epoch: number, bytes: number): Promise<TerminalResult<void>>
  close(terminalId: string): Promise<TerminalResult<void>>
  generateDraft(
    input: TerminalGenerateDraftInput
  ): Promise<TerminalResult<TerminalDraftGenerationResult>>
  cancelDraft(requestId: string): Promise<TerminalResult<void>>
  submitDraft(input: TerminalSubmitDraftInput): Promise<TerminalResult<void>>
  onEvent(cb: (event: TerminalEvent) => void): () => void
}

export interface TerminalDraftRequiredInput {
  name: string
  description: string
}

export interface TerminalCommandDraft {
  draftId: string
  terminalId: string
  workspaceKey: string
  source: string
  explanation: string
  requiredInputs: TerminalDraftRequiredInput[]
}

export type TerminalDraftGenerationResult = TerminalCommandDraft & { selectionTruncated?: boolean }

export interface TerminalGenerateDraftInput {
  requestId: string
  terminalId: string
  kind: 'command' | 'explain'
  request: string
  selection?: string
}

export interface TerminalSubmitDraftInput {
  requestId: string
  draftId: string
  source: string
  bracketedPaste: boolean
}
