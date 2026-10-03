import { createHash, randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { InlineExtension } from './runtime/runtime-adapter'
import { planModeToolDecision } from './plan/plan-tool-policy'

export interface ToolApprovalRequest {
  requestId: string
  toolCallId?: string
  agentRunId?: string
  approvalDigest?: string
  sessionId?: string
  sessionPath?: string
  sessionGeneration?: number
  runId?: string
  cwd?: string
  projectName?: string
  toolName: string
  command?: string
  summary: string
  browser?: {
    origin: string
    action: 'click' | 'typeText' | 'scroll' | 'keypress'
    consequence: 'read' | 'write' | 'irreversible'
    reason: 'external_origin' | 'form_submission' | 'irreversible'
  }
}

const RISKY_TOOLS = new Set([
  'bash',
  'powershell',
  'edit',
  'write',
  'mcp__composio_multi_execute_tool',
  'mcp__composio_manage_connections',
  'mcp__composio_remote_workbench',
  'mcp__composio_remote_bash_tool'
])

type ApprovalWindow = BrowserWindow

interface CreateApprovalExtensionOptions {
  signal?: AbortSignal
  shouldGate?: () => boolean
  getWindow?: () => ApprovalWindow | null
  getContext?: (event: { agentRunId?: string }) => ToolApprovalContext | null
  /**
   * Extra gate for tools the host classifies per call (`skill_run`, script tools).
   * `exec` and `write` are approved like `bash`. `read` and `undefined` leave the
   * built-in risky-tool list unchanged.
   */
  classifyTool?: (
    toolName: string,
    input: Record<string, unknown>
  ) => 'exec' | 'read' | 'write' | undefined
  onApprovalRequested?: (request: ToolApprovalRequest) => void
  onApprovalResolved?: (request: ToolApprovalRequest, approved: boolean) => void
  onApprovalCancelled?: (request: ToolApprovalRequest) => void
}

interface PendingApproval {
  request: ToolApprovalRequest
  responder: unknown
  settle: (decision: ApprovalDecision) => void
}

export interface ToolApprovalContext {
  sessionId: string
  sessionPath?: string
  sessionGeneration?: number
  runId: string
  cwd: string
  projectName?: string
  scopeNote?: string
  writeScopeNote?: string
}

interface ApprovalDecision {
  approved: boolean
  cancelled: boolean
}

const pendingApprovals = new Map<string, PendingApproval>()

function summarizeSkillRun(input: Record<string, unknown>): string {
  const skill = typeof input.skill === 'string' ? input.skill : ''
  const script = typeof input.script === 'string' ? input.script : ''
  const args = Array.isArray(input.args)
    ? input.args.filter((item): item is string => typeof item === 'string')
    : []
  return [`${skill}/${script}`, ...args].join(' ')
}

function summarizeClassifiedToolCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'skill_run') return summarizeSkillRun(input)
  return JSON.stringify(input)
}

function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'bash' || toolName === 'powershell') {
    if (typeof input.command !== 'string') return JSON.stringify(input)
    return [
      input.command,
      ...(typeof input.cwd === 'string' ? [`cwd: ${input.cwd}`] : []),
      ...(typeof input.timeout === 'number' ? [`timeout: ${input.timeout}s`] : []),
      ...(input.env && typeof input.env === 'object' && !Array.isArray(input.env)
        ? [`env keys: ${Object.keys(input.env).sort().join(', ')}`]
        : [])
    ].join('\n')
  }
  if (toolName === 'write' || toolName === 'edit') {
    return typeof input.path === 'string' ? input.path : JSON.stringify(input)
  }
  return JSON.stringify(input)
}

/** Bind an approval to every execution-affecting Bash argument, independent of key order. */
export function bashApprovalDigest(input: Record<string, unknown>): string {
  const env =
    input.env && typeof input.env === 'object' && !Array.isArray(input.env)
      ? Object.fromEntries(
          Object.entries(input.env).sort(([left], [right]) => left.localeCompare(right))
        )
      : input.env
  return createHash('sha256')
    .update(
      JSON.stringify({
        command: input.command,
        cwd: input.cwd,
        timeout: input.timeout,
        env,
        pty: input.pty,
        async: input.async
      })
    )
    .digest('hex')
}

/** A remote write approval is bound to both destination and exact UTF-8 content. */
export function writeApprovalDigest(input: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify({ path: input.path, content: input.content, operation: 'write' }))
    .digest('hex')
}

export function editApprovalDigest(input: Record<string, unknown>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        path: input.path,
        old_string: input.old_string,
        new_string: input.new_string,
        replace_all: input.replace_all,
        operation: 'edit'
      })
    )
    .digest('hex')
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

export function resolveToolApproval(
  requestId: string,
  approved: boolean,
  responder: unknown
): boolean {
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 256)
    return false
  if (typeof approved !== 'boolean') return false
  const pending = pendingApprovals.get(requestId)
  if (!pending || pending.responder !== responder) return false
  pending.settle({ approved, cancelled: false })
  return true
}

export function cancelToolApprovals(scope?: {
  sessionId?: string
  runId?: string
  toolCallId?: string
}): ToolApprovalRequest[] {
  const cancelled: ToolApprovalRequest[] = []
  for (const pending of [...pendingApprovals.values()]) {
    if (scope?.sessionId && pending.request.sessionId !== scope.sessionId) continue
    if (scope?.runId && pending.request.runId !== scope.runId) continue
    if (scope?.toolCallId && pending.request.toolCallId !== scope.toolCallId) continue
    cancelled.push(pending.request)
    pending.settle({ approved: false, cancelled: true })
  }
  return cancelled
}

function waitForApproval(
  request: ToolApprovalRequest,
  window: ApprovalWindow,
  signals: ReadonlyArray<AbortSignal | undefined>
): Promise<ApprovalDecision> {
  if (pendingApprovals.has(request.requestId)) {
    return Promise.resolve({ approved: false, cancelled: true })
  }
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

    const pending: PendingApproval = { request, responder: window.webContents, settle }
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

export interface RequestToolApprovalOptions {
  signal?: AbortSignal
  getWindow?: () => ApprovalWindow | null
  requestId?: () => string
  context: ToolApprovalContext
  toolCallId: string
  browser: NonNullable<ToolApprovalRequest['browser']>
  onApprovalRequested?: (request: ToolApprovalRequest) => void
  onApprovalResolved?: (request: ToolApprovalRequest, approved: boolean) => void
  onApprovalCancelled?: (request: ToolApprovalRequest) => void
}

function safeBrowserApprovalMetadata(
  value: RequestToolApprovalOptions['browser']
): NonNullable<ToolApprovalRequest['browser']> | null {
  try {
    const parsed = new URL(value.origin)
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.origin !== value.origin ||
      !['click', 'typeText', 'scroll', 'keypress'].includes(value.action) ||
      !['read', 'write', 'irreversible'].includes(value.consequence) ||
      !['external_origin', 'form_submission', 'irreversible'].includes(value.reason)
    ) {
      return null
    }
    return { ...value }
  } catch {
    return null
  }
}

function browserApprovalSummary(browser: NonNullable<ToolApprovalRequest['browser']>): string {
  const actionLabels = {
    click: '点击',
    typeText: '输入文本',
    scroll: '滚动',
    keypress: '按键'
  }
  const consequenceLabels = {
    read: '读取/导航',
    write: '修改页面状态',
    irreversible: '不可逆操作'
  }
  const reasonLabels = {
    external_origin: '外部网站操作',
    form_submission: '提交表单',
    irreversible: '不可逆操作'
  }
  return [
    `来源：${browser.origin}`,
    `操作：${actionLabels[browser.action]}`,
    `影响：${consequenceLabels[browser.consequence]}`,
    `原因：${reasonLabels[browser.reason]}`
  ].join('\n')
}

export async function requestToolApproval(
  options: RequestToolApprovalOptions
): Promise<'approved' | 'denied' | 'cancelled'> {
  const browser = safeBrowserApprovalMetadata(options.browser)
  if (!browser || options.signal?.aborted) return 'cancelled'
  const window = options.getWindow ? options.getWindow() : getActiveWindow()
  if (!isUsableWindow(window)) return 'cancelled'
  const requestId = options.requestId ? options.requestId() : randomUUID()
  if (!requestId || requestId.length > 256 || pendingApprovals.has(requestId)) return 'cancelled'
  const request: ToolApprovalRequest = {
    requestId,
    toolCallId: options.toolCallId,
    sessionId: options.context.sessionId,
    ...(options.context.sessionPath ? { sessionPath: options.context.sessionPath } : {}),
    ...(typeof options.context.sessionGeneration === 'number'
      ? { sessionGeneration: options.context.sessionGeneration }
      : {}),
    runId: options.context.runId,
    cwd: options.context.cwd,
    ...(options.context.projectName ? { projectName: options.context.projectName } : {}),
    toolName: 'browser',
    summary: browserApprovalSummary(browser),
    browser
  }
  options.onApprovalRequested?.(request)
  const decision = await waitForApproval(request, window, [options.signal])
  if (decision.cancelled) options.onApprovalCancelled?.(request)
  else options.onApprovalResolved?.(request, decision.approved)
  return decision.cancelled ? 'cancelled' : decision.approved ? 'approved' : 'denied'
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

// Gates local mutations, Composio execution/connection calls, and skill tools
// classified as exec or write on an explicit renderer approval. Read-only tools
// and script tools classified as read stay auto-approved. Used for projects whose
// permissionMode is 'ask' (see projects.ts).
export function createApprovalExtension(
  options: CreateApprovalExtensionOptions = {}
): InlineExtension {
  return {
    name: 'phi-tool-approval',
    hidden: true,
    factory: (pi) => {
      pi.on('tool_call', async (event, ctx) => {
        const classified = options.classifyTool?.(event.toolName, event.input)
        if (classified !== 'exec' && classified !== 'write' && !RISKY_TOOLS.has(event.toolName)) {
          return undefined
        }
        if (
          (event.toolName === 'write' || event.toolName === 'edit') &&
          planModeToolDecision(true, event.toolName, event.input).allowed
        ) {
          return undefined
        }
        if (options.shouldGate && !options.shouldGate()) return undefined

        if (options.signal?.aborted || ctx.signal?.aborted) {
          return { block: true, reason: createAbortErrorMessage(options.signal ?? ctx.signal) }
        }

        const window = options.getWindow ? options.getWindow() : getActiveWindow()
        if (!isUsableWindow(window)) {
          return { block: true, reason: '没有可用窗口来请求批准' }
        }

        const requestId = randomUUID()
        const context = options.getContext?.(event) ?? null
        const request: ToolApprovalRequest = {
          requestId,
          ...(typeof event.toolCallId === 'string' ? { toolCallId: event.toolCallId } : {}),
          ...(typeof event.agentRunId === 'string' ? { agentRunId: event.agentRunId } : {}),
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
          ...(event.toolName === 'bash' && typeof event.input.command === 'string'
            ? {
                command: event.input.command,
                approvalDigest: bashApprovalDigest(event.input)
              }
            : {}),
          ...(event.toolName === 'write' &&
          typeof event.input.path === 'string' &&
          typeof event.input.content === 'string'
            ? { approvalDigest: writeApprovalDigest(event.input) }
            : {}),
          ...(event.toolName === 'edit' &&
          typeof event.input.path === 'string' &&
          typeof event.input.old_string === 'string' &&
          typeof event.input.new_string === 'string'
            ? { approvalDigest: editApprovalDigest(event.input) }
            : {}),
          summary: [
            event.toolName === 'write' || event.toolName === 'edit'
              ? context?.writeScopeNote
              : context?.scopeNote,
            classified === 'exec' || classified === 'write'
              ? summarizeClassifiedToolCall(event.toolName, event.input)
              : summarizeToolCall(event.toolName, event.input)
          ]
            .filter(Boolean)
            .join('\n')
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
