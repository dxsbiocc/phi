import {
  TERMINAL_CREDIT_WINDOW_BYTES,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
  TERMINAL_RING_BUFFER_BYTES,
  type TerminalAttachResult,
  type TerminalDraftGenerationResult,
  type TerminalEvent,
  type TerminalGenerateDraftInput,
  type TerminalResult,
  type TerminalSnapshot,
  type TerminalSubmitDraftInput,
  type TerminalWorkspaceRef
} from '../../shared/terminalTypes'
import { TerminalError } from './terminal-error'
import { TERMINAL_ID_PATTERN } from './terminal-protocol'

const MAX_PROJECT_ID_BYTES = 256
const MAX_DRAFT_ID_BYTES = 128
const MAX_DRAFT_REQUEST_BYTES = 4 * 1024
const MAX_DRAFT_SOURCE_BYTES = 16 * 1024
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u

export interface TerminalRendererSenderLike {
  mainFrame: unknown
  isDestroyed(): boolean
  send(channel: string, payload: unknown): unknown
}

export interface TerminalIpcEventLike {
  sender: TerminalRendererSenderLike
  senderFrame: unknown
}

export interface TerminalIpcMainLike {
  handle(
    channel: string,
    handler: (event: TerminalIpcEventLike, ...args: unknown[]) => unknown
  ): unknown
}

export interface TerminalManagerLike {
  list(workspace: TerminalWorkspaceRef): Promise<TerminalSnapshot[]>
  create(
    workspace: TerminalWorkspaceRef,
    cols: number,
    rows: number,
    requestId: string
  ): Promise<TerminalSnapshot>
  attach(terminalId: string): Promise<TerminalAttachResult>
  input(terminalId: string, data: string): Promise<void>
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  ack(terminalId: string, epoch: number, bytes: number): Promise<void>
  close(terminalId: string): Promise<void>
}

export interface TerminalDraftServiceLike {
  generate(input: TerminalGenerateDraftInput): Promise<TerminalDraftGenerationResult>
  cancel(requestId: string): void | Promise<void>
  submit(input: TerminalSubmitDraftInput): Promise<void>
  terminalClosed(terminalId: string): void
}

export interface TerminalIpcCoordinatorOptions {
  getManager: () => TerminalManagerLike
  getDraftService: () => TerminalDraftServiceLike
  getTrustedRenderer: () => TerminalRendererSenderLike | null
  platform?: NodeJS.Platform
}

function invalidRequest(): never {
  throw new TerminalError('invalid', 'Invalid terminal request')
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidRequest()
  return value as Record<string, unknown>
}

function exactRecord(value: unknown, expected: readonly string[]): Record<string, unknown> {
  const input = record(value)
  const actual = Object.keys(input).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    return invalidRequest()
  }
  return input
}

function boundedString(
  value: unknown,
  maxBytes: number,
  options: { allowEmpty?: boolean; rejectNul?: boolean } = {}
): string {
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.length === 0) ||
    (options.rejectNul && value.includes('\0')) ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    return invalidRequest()
  }
  return value
}

function terminalId(value: unknown): string {
  const parsed = boundedString(value, 64)
  return TERMINAL_ID_PATTERN.test(parsed) ? parsed : invalidRequest()
}

function dimension(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    return invalidRequest()
  }
  return value as number
}

function positiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
    return invalidRequest()
  }
  return value as number
}

function workspaceRef(value: unknown): TerminalWorkspaceRef {
  const input = record(value)
  if (input.kind === 'ordinary') {
    exactRecord(input, ['kind'])
    return { kind: 'ordinary' }
  }
  if (input.kind === 'project') {
    const parsed = exactRecord(input, ['kind', 'projectId'])
    return {
      kind: 'project',
      projectId: boundedString(parsed.projectId, MAX_PROJECT_ID_BYTES, { rejectNul: true })
    }
  }
  return invalidRequest()
}

function requestId(value: unknown): string {
  const parsed = boundedString(value, 64)
  return REQUEST_ID_PATTERN.test(parsed) ? parsed : invalidRequest()
}

function draftSelection(value: unknown): string {
  return typeof value === 'string' && !value.includes('\0') ? value : invalidRequest()
}

export class TerminalIpcCoordinator {
  private readonly getManager: TerminalIpcCoordinatorOptions['getManager']
  private readonly getDraftService: TerminalIpcCoordinatorOptions['getDraftService']
  private readonly getTrustedRenderer: TerminalIpcCoordinatorOptions['getTrustedRenderer']
  private readonly platform: NodeJS.Platform

  constructor(options: TerminalIpcCoordinatorOptions) {
    this.getManager = options.getManager
    this.getDraftService = options.getDraftService
    this.getTrustedRenderer = options.getTrustedRenderer
    this.platform = options.platform ?? process.platform
  }

  list(event: TerminalIpcEventLike, input: unknown): Promise<TerminalResult<TerminalSnapshot[]>> {
    return this.run(event, async () => {
      const workspace = workspaceRef(input)
      if (this.platform !== 'darwin') return []
      return await this.getManager().list(workspace)
    })
  }

  create(event: TerminalIpcEventLike, input: unknown): Promise<TerminalResult<TerminalSnapshot>> {
    return this.run(event, async () => {
      const parsed = exactRecord(input, ['workspace', 'cols', 'rows', 'requestId'])
      const workspace = workspaceRef(parsed.workspace)
      const cols = dimension(parsed.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS)
      const rows = dimension(parsed.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS)
      const id = requestId(parsed.requestId)
      if (this.platform !== 'darwin') {
        throw new TerminalError(
          'unsupported_platform',
          'Terminal is not supported on this platform'
        )
      }
      return await this.getManager().create(workspace, cols, rows, id)
    })
  }

  attach(
    event: TerminalIpcEventLike,
    input: unknown
  ): Promise<TerminalResult<TerminalAttachResult>> {
    return this.run(event, async () => await this.getManager().attach(terminalId(input)))
  }

  input(event: TerminalIpcEventLike, id: unknown, data: unknown): Promise<TerminalResult<void>> {
    return this.run(event, async () => {
      const safeId = terminalId(id)
      const safeData = boundedString(data, TERMINAL_MAX_INPUT_BYTES, {
        allowEmpty: true,
        rejectNul: true
      })
      await this.getManager().input(safeId, safeData)
    })
  }

  resize(
    event: TerminalIpcEventLike,
    id: unknown,
    cols: unknown,
    rows: unknown
  ): Promise<TerminalResult<void>> {
    return this.run(event, async () => {
      await this.getManager().resize(
        terminalId(id),
        dimension(cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS),
        dimension(rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS)
      )
    })
  }

  ack(
    event: TerminalIpcEventLike,
    id: unknown,
    epoch: unknown,
    bytes: unknown
  ): Promise<TerminalResult<void>> {
    return this.run(event, async () => {
      await this.getManager().ack(
        terminalId(id),
        positiveInteger(epoch),
        positiveInteger(bytes, TERMINAL_RING_BUFFER_BYTES + TERMINAL_CREDIT_WINDOW_BYTES)
      )
    })
  }

  close(event: TerminalIpcEventLike, input: unknown): Promise<TerminalResult<void>> {
    return this.run(event, async () => {
      const id = terminalId(input)
      await this.getManager().close(id)
      this.getDraftService().terminalClosed(id)
    })
  }

  generateDraft(
    event: TerminalIpcEventLike,
    input: unknown
  ): Promise<TerminalResult<TerminalDraftGenerationResult>> {
    return this.run(event, async () => {
      const parsed = exactRecord(
        input,
        record(input).selection === undefined
          ? ['requestId', 'terminalId', 'kind', 'request']
          : ['requestId', 'terminalId', 'kind', 'request', 'selection']
      )
      const kind = parsed.kind
      if (kind !== 'command' && kind !== 'explain') return invalidRequest()
      const selection =
        parsed.selection === undefined ? undefined : draftSelection(parsed.selection)
      return await this.getDraftService().generate({
        requestId: requestId(parsed.requestId),
        terminalId: terminalId(parsed.terminalId),
        kind,
        request: boundedString(parsed.request, MAX_DRAFT_REQUEST_BYTES, {
          allowEmpty: true,
          rejectNul: true
        }),
        ...(selection === undefined ? {} : { selection })
      })
    })
  }

  cancelDraft(event: TerminalIpcEventLike, input: unknown): Promise<TerminalResult<void>> {
    return this.run(event, async () => {
      await this.getDraftService().cancel(requestId(input))
    })
  }

  submitDraft(event: TerminalIpcEventLike, input: unknown): Promise<TerminalResult<void>> {
    return this.run(event, async () => {
      const parsed = exactRecord(input, ['requestId', 'draftId', 'source', 'bracketedPaste'])
      if (typeof parsed.bracketedPaste !== 'boolean') return invalidRequest()
      await this.getDraftService().submit({
        requestId: requestId(parsed.requestId),
        draftId: boundedString(parsed.draftId, MAX_DRAFT_ID_BYTES, { rejectNul: true }),
        source: boundedString(parsed.source, MAX_DRAFT_SOURCE_BYTES, {
          allowEmpty: true,
          rejectNul: true
        }),
        bracketedPaste: parsed.bracketedPaste
      })
    })
  }

  sendEvent(event: TerminalEvent): boolean {
    try {
      const renderer = this.getTrustedRenderer()
      if (!renderer || renderer.isDestroyed()) return false
      renderer.send('terminal:event', event)
      return true
    } catch {
      return false
    }
  }

  invalid<T>(event: TerminalIpcEventLike): Promise<TerminalResult<T>> {
    return this.run(event, () => invalidRequest())
  }

  private async run<T>(
    event: TerminalIpcEventLike,
    operation: () => T | Promise<T>
  ): Promise<TerminalResult<T>> {
    try {
      this.assertTrustedRenderer(event)
      return { ok: true, value: await operation() }
    } catch (error) {
      if (error instanceof TerminalError) {
        return { ok: false, code: error.code, message: error.message }
      }
      return { ok: false, code: 'unavailable', message: 'Terminal is unavailable' }
    }
  }

  private assertTrustedRenderer(event: TerminalIpcEventLike): void {
    const trusted = this.getTrustedRenderer()
    if (
      !trusted ||
      event.sender !== trusted ||
      event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new TerminalError('unavailable', 'Terminal renderer is not authorized')
    }
  }
}

export function registerTerminalRendererIpc(
  ipcMain: TerminalIpcMainLike,
  coordinator: TerminalIpcCoordinator
): void {
  ipcMain.handle('terminal:list', (event, ...args) =>
    args.length === 1 ? coordinator.list(event, args[0]) : coordinator.invalid(event)
  )
  ipcMain.handle('terminal:create', (event, ...args) =>
    args.length === 1 ? coordinator.create(event, args[0]) : coordinator.invalid(event)
  )
  ipcMain.handle('terminal:attach', (event, ...args) =>
    args.length === 1 ? coordinator.attach(event, args[0]) : coordinator.invalid(event)
  )
  ipcMain.handle('terminal:input', (event, ...args) =>
    args.length === 2 ? coordinator.input(event, args[0], args[1]) : coordinator.invalid(event)
  )
  ipcMain.handle('terminal:resize', (event, ...args) =>
    args.length === 3
      ? coordinator.resize(event, args[0], args[1], args[2])
      : coordinator.invalid(event)
  )
  ipcMain.handle('terminal:ack', (event, ...args) =>
    args.length === 3
      ? coordinator.ack(event, args[0], args[1], args[2])
      : coordinator.invalid(event)
  )
  ipcMain.handle('terminal:close', (event, ...args) =>
    args.length === 1 ? coordinator.close(event, args[0]) : coordinator.invalid(event)
  )
  ipcMain.handle('terminal:generateDraft', (event, ...args) =>
    args.length === 1 ? coordinator.generateDraft(event, args[0]) : coordinator.invalid(event)
  )
  ipcMain.handle('terminal:cancelDraft', (event, ...args) =>
    args.length === 1 ? coordinator.cancelDraft(event, args[0]) : coordinator.invalid(event)
  )
  ipcMain.handle('terminal:submitDraft', (event, ...args) =>
    args.length === 1 ? coordinator.submitDraft(event, args[0]) : coordinator.invalid(event)
  )
}
