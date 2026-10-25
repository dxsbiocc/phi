import type { KernelModelAccess } from '../model-access'

const SESSION_CONTROL_METHODS = new Set([
  'session.contextUsage',
  'session.compact',
  'session.getAutoCompaction',
  'session.setAutoCompaction',
  'session.setModel',
  'session.setThinkingLevel',
  'session.dispose'
])

async function callSessionControl(method: string, params: unknown): Promise<unknown> {
  const runtime = await import('../../main/agent/engine/in-process/session-runtime')
  if (method === 'session.contextUsage') return runtime.sessionContextUsage(params)
  if (method === 'session.compact') return runtime.compactSession(params)
  if (method === 'session.getAutoCompaction' || method === 'session.setAutoCompaction') {
    return runtime.setSessionAutoCompactionSettings(params)
  }
  if (method === 'session.setModel') return runtime.setSessionModel(params)
  if (method === 'session.setThinkingLevel') return runtime.setSessionThinkingLevel(params)
  return runtime.disposeSession(params)
}

export async function callKernelRuntime(
  method: string,
  params: unknown,
  modelAccess?: KernelModelAccess
): Promise<unknown> {
  if (SESSION_CONTROL_METHODS.has(method)) return callSessionControl(method, params)
  const runtime = async (): Promise<
    typeof import('../../main/agent/engine/in-process/session-runtime')
  > => import('../../main/agent/engine/in-process/session-runtime')
  switch (method) {
    case 'session.create': {
      const { createSession } = await import('../../main/agent/engine/in-process/session-creation')
      return createSession(params, modelAccess ? { modelAccess } : undefined)
    }
    case 'session.prompt':
      return (await runtime()).promptSession(params)
    case 'session.abort':
      return (await runtime()).abortSession(params)
    case 'toolApproval.result': {
      const [{ pendingToolApprovals }, { isRecord, stringValue }] = await Promise.all([
        import('../../main/agent/engine/in-process/state'),
        import('../../main/agent/engine/in-process/common')
      ])
      const record = isRecord(params) ? params : {}
      const requestId = stringValue(record.requestId)
      const resolve = pendingToolApprovals.get(requestId)
      if (!resolve) return false
      pendingToolApprovals.delete(requestId)
      resolve(record.result ?? null)
      return true
    }
    default:
      throw new Error(`Unsupported kernel worker method: ${method}`)
  }
}
