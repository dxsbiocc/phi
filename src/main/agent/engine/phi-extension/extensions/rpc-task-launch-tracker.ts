import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentSession } from '@oh-my-pi/pi-coding-agent'

type JobManager = NonNullable<AgentSession['asyncJobManager']>
type TaskTool = NonNullable<ReturnType<AgentSession['getToolByName']>>
/** Carries only trusted original TaskTool dispatch ownership across its asynchronous spawn hooks. */
export function createRpcTaskLaunchTracker<T>(options: {
  capture(session: AgentSession, toolCallId: string, input: unknown): T
  seal(call: T): void
  active(call: T): boolean
  registering(call: T, id: string): void
  registered(call: T, id: string): void
  registrationFailed(call: T, id: string): void
}): {
  install(session: AgentSession): void
  assertInstalled(session: AgentSession): void
  current(): T | undefined
} {
  const context = new AsyncLocalStorage<T>()
  const installations = new WeakMap<
    AgentSession,
    { tool: TaskTool; execute: TaskTool['execute'] }
  >()
  const managers = new WeakMap<
    AgentSession,
    { manager: JobManager; register: JobManager['register'] }
  >()
  const assertInstalled = (session: AgentSession): void => {
    const installed = installations.get(session)
    if (
      !installed ||
      session.getToolByName('task') !== installed.tool ||
      installed.tool.execute !== installed.execute
    )
      throw new Error('Native task execution ownership hook was replaced')
    const jobs = managers.get(session)
    if (
      jobs &&
      (session.asyncJobManager !== jobs.manager || jobs.manager.register !== jobs.register)
    )
      throw new Error('Native task scheduling ownership hook was replaced')
  }
  return {
    install: (session) => {
      if (installations.has(session)) return assertInstalled(session)
      const tool = session.getToolByName('task')
      if (!tool) throw new Error('Native TaskTool implementation is unavailable')
      const original = tool.execute
      const manager = session.asyncJobManager
      if (manager) {
        const originalRegister = manager.register
        const register: JobManager['register'] = function (
          this: JobManager,
          type,
          label,
          run,
          metadata
        ) {
          const call = context.getStore()
          if (type !== 'task' || !call)
            return originalRegister.call(this, type, label, run, metadata)
          const id = metadata?.agentId
          if (
            this !== manager ||
            !options.active(call) ||
            typeof id !== 'string' ||
            metadata?.id !== id ||
            metadata.ownerId !== session.getAgentId()
          )
            throw new Error('Native task job lacks its exact dispatch owner')
          options.registering(call, id)
          try {
            const jobId = originalRegister.call(
              this,
              type,
              label,
              (job) =>
                context.run(call, () => {
                  if (!options.active(call)) throw new Error('Native task queued owner was retired')
                  return run(job)
                }),
              metadata
            )
            const job = manager.getJob(jobId)
            if (
              jobId !== id ||
              !job ||
              job.agentId !== id ||
              job.ownerId !== metadata.ownerId ||
              job.type !== 'task'
            ) {
              manager.cancel(jobId)
              throw new Error('Native task job registration differs from its captured dispatch')
            }
            options.registered(call, id)
            return jobId
          } catch (error) {
            options.registrationFailed(call, id)
            throw error
          }
        }
        manager.register = register
        managers.set(session, { manager, register })
      }
      const execute: TaskTool['execute'] = function (id, input, ...rest) {
        assertInstalled(session)
        const call = options.capture(session, id, input)
        return context.run(call, async () => {
          try {
            if (!options.active(call))
              throw new Error('Native task dispatch ownership is unavailable')
            return await original.call(this, id, input, ...rest)
          } finally {
            options.seal(call)
          }
        })
      }
      tool.execute = execute
      installations.set(session, { tool, execute })
    },
    assertInstalled,
    current: () => {
      const call = context.getStore()
      return call && options.active(call) ? call : undefined
    }
  }
}
