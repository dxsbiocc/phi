import type { ITheme, ITerminalInitOnlyOptions, ITerminalOptions } from '@xterm/xterm'

import type {
  TerminalErrorCode,
  TerminalEvent,
  TerminalResult,
  TerminalSnapshot,
  TerminalWorkspaceRef
} from '../../../../../shared/terminalTypes'
import type { TerminalAckBatcher } from './terminalAckBatcher'
import type { TerminalLineInputState } from './terminalDraft'

export interface DisposableLike {
  dispose(): void
}

export interface XtermTerminalLike {
  readonly cols: number
  readonly rows: number
  readonly modes: { readonly bracketedPasteMode: boolean }
  readonly textarea?: {
    addEventListener(type: 'paste', listener: EventListener, options?: boolean): void
    removeEventListener(type: 'paste', listener: EventListener, options?: boolean): void
  }
  options: ITerminalOptions
  loadAddon(addon: unknown): void
  open(host: HTMLElement): void
  write(data: string, callback?: () => void): void
  reset(): void
  clear(): void
  focus(): void
  dispose(): void
  onData(listener: (data: string) => void): DisposableLike
  onSelectionChange?(listener: () => void): DisposableLike
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void
  hasSelection(): boolean
  getSelection(): string
}

export interface XtermFitAddonLike {
  fit(): void
  dispose?(): void
}

export type TerminalConstructor = new (
  options?: ITerminalOptions & ITerminalInitOnlyOptions
) => XtermTerminalLike
export type FitAddonConstructor = new () => XtermFitAddonLike

export interface TerminalControllerDependencies {
  Terminal: TerminalConstructor
  FitAddon: FitAddonConstructor
  createHost(): HTMLElement
  createRequestId(): string
  writeClipboard(text: string): Promise<void>
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimer(timer: ReturnType<typeof setTimeout>): void
}

export interface TerminalSize {
  cols: number
  rows: number
}

export interface TerminalControllerError {
  code: TerminalErrorCode
  message: string
}

export interface TerminalWorkspaceSnapshot {
  /** Stable renderer-side key derived from TerminalWorkspaceRef. */
  workspaceKey: string
  terminals: readonly TerminalSnapshot[]
  activeTerminalId: string | null
  pending: boolean
  error: TerminalControllerError | null
}

export interface WorkspaceRecord {
  ref: TerminalWorkspaceRef
  snapshot: TerminalWorkspaceSnapshot
  initialized: boolean
  restorePromise?: Promise<TerminalWorkspaceSnapshot>
  ensurePromise?: Promise<TerminalWorkspaceSnapshot>
  createPromise?: Promise<TerminalSnapshot | null>
}

export interface TerminalRecord {
  snapshot: TerminalSnapshot
  workspaceClientKey: string
  terminal: XtermTerminalLike
  fitAddon: XtermFitAddonLike
  host: HTMLElement
  view: TerminalView
  epoch: number | null
  attaching: boolean
  attachVersion: number
  stateVersion: number
  pendingEvents: Array<Extract<TerminalEvent, { type: 'data' | 'gap' }>>
  ackBatcher: TerminalAckBatcher
  inputChain: Promise<void>
  inputDisposable: DisposableLike
  selectionDisposable?: DisposableLike
  lineInputState: TerminalLineInputState
  interactionListeners: Set<() => void>
  pasteHandler: ((text: string) => void) | null
  pendingPaste?: string
  disposed: boolean
}

export interface TerminalView {
  readonly host: HTMLElement
  readonly terminal: XtermTerminalLike
  fitAndResize(): Promise<void>
  focus(): void
  setTheme(theme: ITheme): void
  setPasteHandler(handler: ((text: string) => void) | null): void
  getSelection(): string
  isCurrentLineDirty(): boolean
  markCurrentLineClean(): void
  subscribeInteraction(listener: () => void): () => void
}

export interface TerminalController {
  subscribe(listener: () => void): () => void
  getWorkspaceSnapshot(ref: TerminalWorkspaceRef): TerminalWorkspaceSnapshot
  restoreWorkspace(ref: TerminalWorkspaceRef): Promise<TerminalWorkspaceSnapshot>
  ensureWorkspace(
    ref: TerminalWorkspaceRef,
    initialSize?: TerminalSize
  ): Promise<TerminalWorkspaceSnapshot>
  create(ref: TerminalWorkspaceRef, initialSize?: TerminalSize): Promise<TerminalSnapshot | null>
  select(ref: TerminalWorkspaceRef, terminalId: string): void
  getTerminalView(terminalId: string): TerminalView | null
  attach(terminalId: string): Promise<boolean>
  close(terminalId: string): Promise<boolean>
  closeWorkspace(ref: TerminalWorkspaceRef): Promise<void>
  submitPaste(terminalId: string, text: string): Promise<TerminalResult<void>>
  discardPaste(terminalId: string): void
  dispose(): void
}
