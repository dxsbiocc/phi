import { safeOfficeDeliverMessage } from './office-deliver-errors'
import type { OfficeDeliverApprovalInput } from './office-deliver-approval'

export interface OfficeDeliverHostContext {
  readonly originSessionId?: string
  readonly agentRunId?: string
  readonly toolCallId?: string
}

interface OfficeDeliverHostDependencies<T> {
  resolveActiveRun(originSessionId: string): { readonly runId: string } | undefined
  deliver(runId: string, input: OfficeDeliverApprovalInput, operationId: string): Promise<T>
}

type OfficeDeliverHostResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export function createOfficeDeliverHostHandler<T>(
  dependencies: OfficeDeliverHostDependencies<T>
): (params: unknown, context: OfficeDeliverHostContext) => Promise<OfficeDeliverHostResult<T>> {
  return async (params, context) => {
    const runId = context.agentRunId ?? activeRunId(dependencies, context.originSessionId)
    if (!runId) return failure('no_target')
    if (!context.toolCallId) return failure('missing_operation_id')
    try {
      const value = await dependencies.deliver(
        runId,
        parseOfficeDeliverInput(params),
        context.toolCallId
      )
      return { ok: true, value }
    } catch (error) {
      const code =
        typeof (error as { code?: unknown }).code === 'string'
          ? String((error as { code: string }).code)
          : 'delivery_failed'
      return failure(code)
    }
  }
}

export function parseOfficeDeliverInput(value: unknown): OfficeDeliverApprovalInput {
  if (!isRecord(value)) return {}
  const ignored = new Set(['runId', 'sessionId', 'artifactId', 'path', 'toolCallId'])
  const keys = Object.keys(value).filter((key) => !ignored.has(key))
  if (keys.some((key) => key !== 'outputName')) throw codedError('invalid_name')
  if (!Object.hasOwn(value, 'outputName')) return {}
  if (typeof value.outputName !== 'string') throw codedError('invalid_name')
  return { outputName: value.outputName }
}

function activeRunId(
  dependencies: Pick<OfficeDeliverHostDependencies<unknown>, 'resolveActiveRun'>,
  originSessionId: string | undefined
): string | undefined {
  return originSessionId ? dependencies.resolveActiveRun(originSessionId)?.runId : undefined
}

function failure(code: string): OfficeDeliverHostResult<never> {
  return { ok: false, error: { code, message: safeOfficeDeliverMessage(code) } }
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(safeOfficeDeliverMessage(code)), { code })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
