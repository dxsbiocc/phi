import { buildAgentRunTools, type AgentRunToolRegistry } from '../../agents/run-tools'
import type { AgentRunSnapshot } from '../../agents/registry'
import { parseAgentReport } from '../../agents/report'
import { AGENT_RUN_HOST_METHODS } from '../../agents/run-host'
import type { HostServiceRegistry } from '../host-service-registry'
import type { PhiTool } from '../types'
import { withRemoteSignal } from './history-pager'
import type { RpcChildRunSnapshot } from './subagents/types'
import type { RpcChildWaitOptions, RpcChildWaitResult } from './subagents/child-run-controls'

export interface FacadeAgentRunToolOptions {
  readonly runtimeSessionId: string
  readonly phiSessionId: string
  readonly projectId: string
  readonly host: Pick<HostServiceRegistry, 'invoke'>
  assertCurrent(): void
  list():
    readonly Readonly<RpcChildRunSnapshot>[] | Promise<readonly Readonly<RpcChildRunSnapshot>[]>
  wait(options: RpcChildWaitOptions): Promise<RpcChildWaitResult>
  steer(id: string, message: string, signal?: AbortSignal): Promise<void>
  stop(id: string, signal?: AbortSignal): Promise<Readonly<RpcChildRunSnapshot>>
  readChildReport(run: Readonly<RpcChildRunSnapshot>, signal?: AbortSignal): Promise<string>
  waitCompletionDelivery(id: string): Promise<void>
}

/** Models may control only this live root's existing children. No delegation capability is created here. */
export function createFacadeAgentRunTools(options: FacadeAgentRunToolOptions): PhiTool[] {
  const reported = new Set<string>()
  const reporting = new Map<string, Promise<boolean>>()
  const root = (): void => options.assertCurrent()
  const terminal = (run: Readonly<RpcChildRunSnapshot>): boolean => run.completedAt !== undefined
  const owned = (run: Readonly<RpcChildRunSnapshot>): void => {
    if (run.phiSessionId !== options.phiSessionId || run.projectId !== options.projectId)
      throw new Error('专家任务不属于当前会话或项目。')
  }
  const registry = (signal?: AbortSignal): AgentRunToolRegistry => {
    const guard = (): void => {
      if (signal?.aborted) throw new Error('专家控制操作已取消。')
      try {
        root()
      } catch (cause) {
        throw new Error('专家任务所属会话已退役。', { cause })
      }
    }
    const step = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      guard()
      try {
        const pending = Promise.resolve().then(() => {
          guard()
          return operation()
        })
        const value = signal ? await withRemoteSignal(pending, signal) : await pending
        guard()
        return value
      } catch (cause) {
        if (signal?.aborted) throw new Error('专家控制操作已取消。', { cause })
        throw new Error('专家控制操作未能确认，请查看任务状态。', { cause })
      }
    }
    const list = async (): Promise<readonly Readonly<RpcChildRunSnapshot>[]> => {
      const runs = await step(() => options.list())
      const ids = new Set<string>()
      for (const run of runs) {
        owned(run)
        if (ids.has(run.id)) throw new Error('专家任务标识重复。')
        ids.add(run.id)
      }
      return runs
    }
    const known = async (id: string): Promise<Readonly<RpcChildRunSnapshot> | undefined> => {
      const matches = (await list()).filter((run) => run.id === id || run.nativeId === id)
      if (matches.length > 1) throw new Error('专家任务标识不唯一。')
      return matches[0]
    }
    const project = async (run: Readonly<RpcChildRunSnapshot>): Promise<AgentRunSnapshot> => {
      owned(run)
      const state: AgentRunSnapshot['state'] =
        run.status === 'completed'
          ? 'done'
          : run.status === 'aborted'
            ? 'cancelled'
            : run.status === 'failed' || run.status === 'interrupted'
              ? 'error'
              : run.status
      const report =
        terminal(run) && run.verified && (run.status === 'completed' || run.status === 'failed')
          ? parseAgentReport(
              (await step(() => options.readChildReport(run, signal))).slice(0, 20000)
            )
          : undefined
      return {
        id: run.id,
        agent: run.agent,
        task: '',
        state,
        background: run.background,
        startedAt: run.startedAt,
        ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
        toolCallId: run.parentToolCallId,
        reported: reported.has(run.id),
        ...(report
          ? {
              report: report.text,
              reportStatus: report.status,
              missingInputs: report.missingInputs,
              ...(report.nextAgent ? { nextAgent: report.nextAgent } : {}),
              ...(report.fallbackReason ? { fallbackReason: report.fallbackReason } : {})
            }
          : {}),
        ...(state === 'cancelled'
          ? { error: '专家任务已取消；已产生的文件或后台任务不会撤销。' }
          : state === 'error'
            ? { error: '专家任务失败或已中断，请查看保留的任务记录。' }
            : {})
      }
    }
    return {
      get: async (id) => {
        const run = await known(id)
        return run && project(run)
      },
      list: async () => Promise.all((await list()).map(project)),
      steer: async (id, message) => {
        const run = await known(id)
        if (!run) throw new Error('专家任务不属于当前会话。')
        await step(() => options.steer(run.id, message, signal))
      },
      stop: async (id) => {
        const run = await known(id)
        if (!run || terminal(run)) return false
        const stopped = await step(() => options.stop(run.id, signal))
        owned(stopped)
        if (
          stopped.id !== run.id ||
          stopped.nativeId !== run.nativeId ||
          stopped.generation !== run.generation
        )
          throw new Error('专家停止确认与原任务不一致。')
        return true
      },
      wait: async (ids, waitOptions) => {
        const targets = ids
          ? [
              ...new Set(
                await Promise.all(
                  ids.map(async (id) => {
                    const run = await known(id)
                    if (!run) throw new Error('专家任务不属于当前会话。')
                    return run.id
                  })
                )
              )
            ]
          : (await list()).filter((run) => !terminal(run)).map((run) => run.id)
        const result = await step(() => options.wait({ ...waitOptions, ids: targets, signal }))
        if (result.runs.some((run) => !targets.includes(run.id)))
          throw new Error('专家等待确认包含其他任务。')
        return { runs: await Promise.all(result.runs.map(project)), timedOut: result.timedOut }
      },
      markReported: async (id) => {
        const run = await known(id)
        if (!run || !terminal(run)) return false
        id = run.id
        if (reported.has(id)) return false
        await step(() => options.waitCompletionDelivery(id))
        guard()
        if (reported.has(id)) return false
        let pending = reporting.get(id)
        if (!pending) {
          pending = options.host
            .invoke(
              AGENT_RUN_HOST_METHODS.reported,
              { originSessionId: options.runtimeSessionId, runId: id },
              {
                originSessionId: options.runtimeSessionId,
                agentRunId: id,
                ...(signal ? { signal } : {})
              }
            )
            .then((value) => {
              root()
              if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true)
                throw new Error('专家结果已读确认失败。')
              reported.add(id)
              return true
            })
          reporting.set(id, pending)
          const clear = (): void => {
            if (reporting.get(id) === pending) reporting.delete(id)
          }
          void pending.then(clear, clear)
        }
        return step(() => pending!)
      }
    }
  }
  // A registry per invocation keeps cancellation local even for concurrent controls.
  return buildAgentRunTools(registry()).map((tool, index) => ({
    ...tool,
    site: 'host',
    execute: (...args) => buildAgentRunTools(registry(args[4]))[index].execute(...args)
  }))
}
