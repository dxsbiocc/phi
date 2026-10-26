import type { KernelModelAccess } from '../model-access'
import type { KernelRuntimeServices } from '../../main/agent/engine/in-process/kernel-services'

const SESSION_CONTROL_METHODS = new Set([
  'session.contextUsage',
  'session.compact',
  'session.getAutoCompaction',
  'session.setAutoCompaction',
  'session.setModel',
  'session.setThinkingLevel',
  'session.plan.enter',
  'session.plan.cancel',
  'session.dispose'
])

const AGENT_RUN_METHODS = new Set([
  'agentRun.start',
  'agentRun.steer',
  'agentRun.stop',
  'agentRuns.list',
  'agentRuns.wait'
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
  if (method === 'session.plan.enter') return runtime.enterSessionPlanMode(params)
  if (method === 'session.plan.cancel') return runtime.cancelSessionPlanMode(params)
  return runtime.disposeSession(params)
}

async function callAgentRunRuntime(method: string, params: unknown): Promise<unknown> {
  if (method === 'agentRun.start') {
    const { startSessionAgentRun } =
      await import('../../main/agent/engine/in-process/agent-run-start')
    return startSessionAgentRun(params)
  }
  const runtime = await import('../../main/agent/engine/in-process/subagents')
  if (method === 'agentRun.steer' || method === 'agentRun.stop') {
    return runtime.controlSessionAgentRun(method === 'agentRun.steer' ? 'steer' : 'stop', params)
  }
  if (method === 'agentRuns.list') return runtime.listSessionAgentRuns(params)
  return runtime.waitSessionAgentRun(params)
}

async function callWorkerSessionRuntime(
  method: string,
  params: unknown,
  modelAccess: KernelModelAccess | undefined,
  kernelServices: KernelRuntimeServices | undefined
): Promise<unknown> {
  const runtime = async (): Promise<
    typeof import('../../main/agent/engine/in-process/session-runtime')
  > => import('../../main/agent/engine/in-process/session-runtime')
  switch (method) {
    case 'session.create': {
      const { createSession } = await import('../../main/agent/engine/in-process/session-creation')
      return createSession(params, {
        ...(modelAccess ? { modelAccess } : {}),
        ...(kernelServices ? { kernelServices } : {})
      })
    }
    case 'session.prompt':
      return (await runtime()).promptSession(params)
    case 'session.fork': {
      const { forkWorkerSession } = await import('../../main/agent/engine/in-process/session-fork')
      return forkWorkerSession(params, kernelServices)
    }
    case 'resources.reload': {
      const [{ reloadResources }, { toJsonSafe }] = await Promise.all([
        import('../../main/agent/engine/in-process/resources'),
        import('../../main/agent/engine/in-process/common')
      ])
      return toJsonSafe(await reloadResources(params))
    }
    case 'shellJobs.list':
      return (await runtime()).listSessionShellJobs()
    case 'shellJobs.cancel':
      return (await runtime()).cancelSessionShellJob(params)
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

export async function callKernelRuntime(
  method: string,
  params: unknown,
  modelAccess?: KernelModelAccess,
  kernelServices?: KernelRuntimeServices
): Promise<unknown> {
  if (SESSION_CONTROL_METHODS.has(method)) return callSessionControl(method, params)
  if (AGENT_RUN_METHODS.has(method)) return callAgentRunRuntime(method, params)
  return callWorkerSessionRuntime(method, params, modelAccess, kernelServices)
}
