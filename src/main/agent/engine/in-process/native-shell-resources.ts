import { AsyncLocalStorage } from 'node:async_hooks'
import type { ToolCallContext } from '@oh-my-pi/pi-agent-core'
import type { AgentSession } from '@oh-my-pi/pi-coding-agent'
import { createResourceScheduler } from '../../resource-scheduler'
import type { ExecutionResource } from '../../resource-admission'
import { isRecord } from '../../../../shared/guards'

/** All local sessions and Phi specialists in this execution kernel share the gate. */
const scheduler = createResourceScheduler()
const wrapped = new WeakSet<object>()
const shellClaims: readonly ExecutionResource[] = [
  { namespace: 'local-shell', segments: [], access: 'exclusive' }
]

type NativeToolSession = Pick<AgentSession, 'getToolByName' | 'getAllToolInfos' | 'asyncJobManager'>
type JobManager = NonNullable<AgentSession['asyncJobManager']>
const shellOperations = new AsyncLocalStorage<{ manager: JobManager; jobs: Promise<void>[] }>()
const observedManagers = new WeakSet<JobManager>()

function observeShellJobs(manager: JobManager): void {
  if (observedManagers.has(manager)) return
  const register = manager.register
  manager.register = function (...args) {
    const id = register.apply(this, args)
    const operation = shellOperations.getStore()
    if (args[0] === 'bash' && operation?.manager === this) {
      const job = this.getJob(id)
      if (job) operation.jobs.push(job.promise)
    }
    return id
  }
  observedManagers.add(manager)
}

function scheduleNativeTool<T>(
  signal: AbortSignal | undefined,
  execute: () => Promise<T>,
  onWait: () => void,
  manager?: JobManager
): Promise<T> {
  if (!manager) return scheduler.run(shellClaims, signal, execute, onWait)
  return new Promise<T>((resolve, reject) => {
    void scheduler
      .run(
        shellClaims,
        signal,
        async () => {
          const jobs: Promise<void>[] = []
          try {
            // An auto-backgrounded tool can return before the job exits. On cancellation
            // its status may also become terminal before cleanup. Join the exact jobs
            // registered by this call, without delaying delivery of the tool result.
            resolve(await shellOperations.run({ manager, jobs }, execute))
          } catch (error) {
            reject(error)
          } finally {
            await Promise.allSettled(jobs)
          }
        },
        onWait
      )
      .catch(reject)
  })
}

/** Admit only the regular OMP model-loop Bash path whose completion Phi can observe. */
export function installNativeShellResources(session: NativeToolSession): void {
  const tool = session.getToolByName('bash')
  if (!tool || wrapped.has(tool)) return
  if (
    !session
      .getAllToolInfos()
      .some((info) => info.name === 'bash' && info.sourceInfo.source === 'builtin')
  )
    return

  const execute = tool.execute
  const manager = session.asyncJobManager
  if (manager) observeShellJobs(manager)
  tool.execute = function (id, args, signal, onUpdate, context): ReturnType<typeof execute> {
    const invoke = (): ReturnType<typeof execute> =>
      execute.call(this, id, args, signal, onUpdate, context)
    // OMP augments the core SDK context at runtime; its root type omits the augmentation.
    const callContext = (context as { toolCall?: ToolCallContext } | undefined)?.toolCall
    const call = callContext?.toolCalls[callContext.index]
    if (call?.id !== id || call.name !== 'bash') return invoke()
    // Named services and interactive terminals have their own lifetimes. Keep
    // those paths and direct provider dispatch on their existing policy.
    if (
      isRecord(args) &&
      (args.pty === true || (typeof args.name === 'string' && args.name.trim()))
    )
      return invoke()
    let waited = false
    const report = (waiting: boolean): void => {
      try {
        onUpdate?.({ content: [], details: { kind: 'phi_local_resource_wait', waiting } })
      } catch {
        // Progress listeners cannot prevent the call from running.
      }
    }
    return scheduleNativeTool(
      signal,
      () => {
        if (waited) report(false)
        return invoke()
      },
      () => {
        waited = true
        report(true)
      },
      manager
    )
  }
  wrapped.add(tool)
}
