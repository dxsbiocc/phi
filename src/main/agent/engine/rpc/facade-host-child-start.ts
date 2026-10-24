import type { WorkMode } from '../../../../shared/sessionMode'
import type { PhiRuntimeRef } from '../../session/runtime-reference'
import { RuntimeReferenceError } from '../../session/runtime-reference'
import { CodedError } from '../../../../shared/errorCodes'
import type { RemoteSessionRuntime } from './remote-session-runtime'

export interface FacadeHostChildStartInput {
  readonly agent?: string
  readonly task: string
  readonly requestId: string
}

export function createFacadeHostChildStarter(options: {
  readonly enabled: boolean
  readonly workMode: WorkMode
  readonly allowedAgents: readonly string[]
  readonly phiSessionId: string
  readonly projectId: string
  readonly cwd: string
  readonly capture: () => {
    readonly runtime: RemoteSessionRuntime | undefined
    readonly reference: PhiRuntimeRef | undefined
    readonly epoch: number
    readonly busy: boolean
  }
  readonly assertCurrent: () => void
  readonly setPending: (pending: boolean) => void
}): (input: FacadeHostChildStartInput) => Promise<{ runId: string }> {
  return async (input) => {
    const agent = input.agent ?? 'PlanStep'
    if (
      !options.enabled ||
      options.workMode !== 'plan_execute' ||
      !options.allowedAgents.includes(agent)
    )
      throw new Error('Remote plan child start is not enabled for this agent')
    if (
      !input.task.trim() ||
      Buffer.byteLength(input.task, 'utf8') > 32 * 1024 ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(input.requestId)
    )
      throw new Error('Remote plan child requires a bounded task and persisted UUID requestId')
    options.assertCurrent()
    const owner = options.capture()
    const { runtime, reference, epoch } = owner
    if (
      owner.busy ||
      !runtime?.isReady ||
      !reference ||
      reference.projectId !== options.projectId ||
      reference.projectRoot !== options.cwd
    )
      throw new RuntimeReferenceError('STALE_GENERATION', '远程计划子任务运行归属不可用')
    options.setPending(true)
    try {
      const result = await runtime.startHostChild(agent, input.task, input.requestId, {
        phiSessionId: options.phiSessionId,
        projectId: options.projectId,
        cwd: options.cwd,
        rootOmpSessionId: reference.ompSessionId
      })
      try {
        options.assertCurrent()
        const current = options.capture()
        if (
          current.runtime !== runtime ||
          current.epoch !== epoch ||
          !current.reference ||
          current.reference.projectId !== options.projectId ||
          current.reference.projectRoot !== options.cwd ||
          current.reference.ompSessionId !== reference.ompSessionId ||
          current.reference.bindingHash !== reference.bindingHash ||
          current.reference.durableSessionKey !== reference.durableSessionKey
        )
          throw new RuntimeReferenceError('STALE_GENERATION', '远程计划子任务运行归属已改变')
      } catch (cause) {
        throw new CodedError(
          'TIMEOUT_UNKNOWN',
          `Remote plan child ${input.requestId} started under a retired runtime owner`,
          { cause }
        )
      }
      return result
    } finally {
      options.setPending(false)
    }
  }
}
