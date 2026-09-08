import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { InlineExtension } from './runtime-adapter'

export interface ToolApprovalRequest {
  requestId: string
  sessionId?: string
  sessionPath?: string
  sessionGeneration?: number
  runId?: string
  cwd?: string
  projectName?: string
  toolName: string
  summary: string
}

const RISKY_TOOLS = new Set(['bash', 'powershell', 'edit', 'write'])

type ApprovalWindow = BrowserWindow

interface CreateApprovalExtensionOptions {
  signal?: AbortSignal
  getWindow?: () => ApprovalWindow | null
  getContext?: () => ToolApprovalContext | null
  onApprovalRequested?: (request: ToolApprovalRequest) => void
  onApprovalResolved?: (request: ToolApprovalRequest, approved: boolean) => void
  onApprovalCancelled?: (request: ToolApprovalRequest) => void
}

interface PendingApproval {
  settle: (decision: ApprovalDecision) => void
}

export interface ToolApprovalContext {
  sessionId: string
  sessionPath?: string
  sessionGeneration?: number
  runId: string
  cwd: string
  projectName?: string
}

interface ApprovalDecision {
  approved: boolean
  cancelled: boolean
}

const pendingApprovals = new Map<string, PendingApproval>()

function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'bash' || toolName === 'powershell') {
    return typeof input.command === 'string' ? input.command : JSON.stringify(input)
  }
  if (toolName === 'write' || toolName === 'edit') {
    return typeof input.path === 'string' ? input.path : JSON.stringify(input)
  }
  return JSON.stringify(input)
}

function getActiveWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ??
    null
  )
}

function isUsableWindow(window: ApprovalWindow | null): window is ApprovalWindow {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed?.())
}

function createAbortErrorMessage(signal: AbortSignal | undefined): string {
  return signal?.aborted ? '操作已取消' : '用户拒绝了该操作'
}

export function resolveToolApproval(requestId: string, approved: boolean): void {
  pendingApprovals.get(requestId)?.settle({ approved, cancelled: false })
}

export function cancelToolApprovals(): void {
  for (const pending of [...pendingApprovals.values()]) {
    pending.settle({ approved: false, cancelled: true })
  }
}

function waitForApproval(
  request: ToolApprovalRequest,
  window: ApprovalWindow,
  signals: ReadonlyArray<AbortSignal | undefined>
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    let settled = false
    const cleanupFns: Array<() => void> = []

    const settle = (decision: ApprovalDecision): void => {
      if (settled) return
      settled = true
      pendingApprovals.delete(request.requestId)
      for (const cleanup of cleanupFns.splice(0)) {
        cleanup()
      }
      resolve(decision)
    }

    const pending: PendingApproval = { settle }
    pendingApprovals.set(request.requestId, pending)

    for (const signal of signals) {
      if (!signal) continue
      if (signal.aborted) {
        settle({ approved: false, cancelled: true })
        return
      }
      const onAbort = (): void => settle({ approved: false, cancelled: true })
      signal.addEventListener('abort', onAbort, { once: true })
      cleanupFns.push(() => signal.removeEventListener('abort', onAbort))
    }

    cleanupFns.push(
      addWindowUnavailableListener(window, () => settle({ approved: false, cancelled: true }))
    )

    try {
      window.webContents.send('tool:approval-request', request)
    } catch {
      settle({ approved: false, cancelled: true })
    }
  })
}

function addWindowUnavailableListener(window: ApprovalWindow, callback: () => void): () => void {
  const webContents = window.webContents
  const onUnavailable = (): void => callback()
  const onNavigation = (...args: unknown[]): void => {
    const isInPlace = args[2]
    const isMainFrame = args[3]
    if (isInPlace === true || isMainFrame === false) return
    callback()
  }

  window.once('closed', onUnavailable)
  webContents.once('destroyed', onUnavailable)
  webContents.once('render-process-gone', onUnavailable)
  webContents.on('did-start-navigation', onNavigation)

  return () => {
    window.removeListener('closed', onUnavailable)
    webContents.removeListener('destroyed', onUnavailable)
    webContents.removeListener('render-process-gone', onUnavailable)
    webContents.removeListener('did-start-navigation', onNavigation)
  }
}

// Gates bash/edit/write/powershell tool calls on an explicit approve/deny from the
// renderer — read/grep/find/ls stay auto-approved since they can't change anything.
// Used for projects whose permissionMode is 'ask' (see projects.ts).
export function createApprovalExtension(
  options: CreateApprovalExtensionOptions = {}
): InlineExtension {
  return {
    name: 'phi-tool-approval',
    hidden: true,
    factory: (pi) => {
      pi.on('tool_call', async (event, ctx) => {
        if (!RISKY_TOOLS.has(event.toolName)) {
          return undefined
        }

        if (options.signal?.aborted || ctx.signal?.aborted) {
          return { block: true, reason: createAbortErrorMessage(options.signal ?? ctx.signal) }
        }

        const window = options.getWindow ? options.getWindow() : getActiveWindow()
        if (!isUsableWindow(window)) {
          return { block: true, reason: '没有可用窗口来请求批准' }
        }

        const requestId = randomUUID()
        const context = options.getContext?.() ?? null
        const request: ToolApprovalRequest = {
          requestId,
          ...(context
            ? {
                sessionId: context.sessionId,
                ...(context.sessionPath ? { sessionPath: context.sessionPath } : {}),
                ...(typeof context.sessionGeneration === 'number'
                  ? { sessionGeneration: context.sessionGeneration }
                  : {}),
                runId: context.runId,
                cwd: context.cwd,
                ...(context.projectName ? { projectName: context.projectName } : {})
              }
            : {}),
          toolName: event.toolName,
          summary: summarizeToolCall(event.toolName, event.input)
        }
        options.onApprovalRequested?.(request)
        const decision = await waitForApproval(request, window, [options.signal, ctx.signal])
        if (decision.cancelled) {
          options.onApprovalCancelled?.(request)
        } else {
          options.onApprovalResolved?.(request, decision.approved)
        }

        return decision.approved
          ? undefined
          : { block: true, reason: createAbortErrorMessage(options.signal ?? ctx.signal) }
      })
    }
  }
}
