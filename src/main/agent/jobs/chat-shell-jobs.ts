import { randomUUID } from 'node:crypto'
import type {
  BackgroundShellJob,
  ShellJobTimelineEvent,
  StartChatShellJobRequest
} from '../../../shared/backgroundJobTypes'
import { errorMessage } from '../../../shared/errorCodes'
import { isRecord } from '../../../shared/guards'
import { protectedHomeWriteDecision } from '../engine/phi-extension/lib/project-boundary'
import { redactSensitiveText } from '../redaction'
import type { CommandResult } from '../workspace-host/types'
import { CHAT_SHELL_LAUNCH_ID } from './chat-shell-history'

export const CHAT_SHELL_MAX_OUTPUT_BYTES = 256 * 1024
const MAX_ACTIVE_JOBS = 8
const MAX_RECENT_JOBS = 50
const MAX_COMMAND_BYTES = 64 * 1024
const OUTPUT_PREVIEW_LENGTH = 4_000
const MAX_RUN_MS = 24 * 60 * 60 * 1000

export type ChatShellOrigin = {
  sessionPath: string
  sessionTitle: string
  run: (command: string, signal: AbortSignal) => Promise<CommandResult>
}

interface ChatShellJobsOptions {
  resolveOrigin: (sessionId: string) => ChatShellOrigin
  publish: (event: ShellJobTimelineEvent) => void
  storeOutput: (job: BackgroundShellJob, output: string) => string | undefined
  onError: (error: unknown) => void
}

interface ActiveJob {
  job: BackgroundShellJob
  controller: AbortController
  command: string
  done: Promise<void>
}

function checkedRequest(input: unknown): StartChatShellJobRequest {
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => key !== 'sessionId' && key !== 'command') ||
    typeof input.sessionId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionId) ||
    typeof input.command !== 'string' ||
    !input.command.trim() ||
    input.command.includes('\0') ||
    Buffer.byteLength(input.command) > MAX_COMMAND_BYTES
  ) {
    throw new Error('Invalid background Bash command')
  }
  const decision = protectedHomeWriteDecision('bash', { command: input.command })
  if (!decision.allowed) throw new Error(decision.reason)
  return { sessionId: input.sessionId, command: input.command }
}

export class ChatShellJobs {
  private readonly active = new Map<string, ActiveJob>()
  private readonly recent: BackgroundShellJob[] = []
  private shuttingDown = false

  constructor(private readonly options: ChatShellJobsOptions) {}

  start(input: unknown): BackgroundShellJob {
    if (this.shuttingDown) throw new Error('Phi is shutting down')
    const { sessionId, command } = checkedRequest(input)
    const duplicate = [...this.active.values()].find(
      (active) => active.job.sessionId === sessionId && active.command === command
    )
    if (duplicate) return duplicate.job
    if (this.active.size >= MAX_ACTIVE_JOBS) {
      throw new Error('Too many background Bash commands are running')
    }
    const origin = this.options.resolveOrigin(sessionId)
    const job: BackgroundShellJob = {
      jobId: randomUUID(),
      agentSessionId: sessionId,
      sessionId,
      sessionPath: origin.sessionPath,
      sessionTitle: origin.sessionTitle,
      command: redactSensitiveText(command).slice(0, 4_000),
      state: 'running',
      startedAt: new Date().toISOString()
    }
    const controller = new AbortController()
    this.options.publish({
      type: 'shell_job_started',
      shellJob: job,
      shellJobLaunchId: CHAT_SHELL_LAUNCH_ID
    })
    const done = Promise.resolve()
      .then(() => this.run(job, origin, command, controller.signal))
      .catch(this.options.onError)
    this.active.set(job.jobId, { job, controller, command, done })
    return job
  }

  list(): BackgroundShellJob[] {
    return [...Array.from(this.active.values(), ({ job }) => job), ...this.recent]
  }

  async stop(agentSessionId: unknown, jobId: unknown): Promise<boolean> {
    if (typeof jobId !== 'string') return false
    const active = this.active.get(jobId)
    if (!active) return false
    if (active.job.agentSessionId !== agentSessionId) throw new Error('Shell job owner mismatch')
    active.controller.abort()
    await active.done
    return true
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true
    const activeJobs = [...this.active.values()]
    for (const active of activeJobs) active.controller.abort()
    await Promise.allSettled(activeJobs.map(({ done }) => done))
  }

  private async run(
    job: BackgroundShellJob,
    origin: ChatShellOrigin,
    command: string,
    userSignal: AbortSignal
  ): Promise<void> {
    const timeout = AbortSignal.timeout(MAX_RUN_MS)
    const signal = AbortSignal.any([userSignal, timeout])
    let result: CommandResult | undefined
    let failure: string | undefined
    try {
      signal.throwIfAborted()
      result = await origin.run(command, signal)
    } catch (error) {
      if (!signal.aborted) failure = errorMessage(error)
    }
    if (timeout.aborted) failure = 'The background Bash command exceeded its 24-hour time limit.'
    this.finish(job, result, failure, userSignal.aborted)
  }

  private finish(
    job: BackgroundShellJob,
    result: CommandResult | undefined,
    failure: string | undefined,
    cancelled: boolean
  ): void {
    const state = cancelled ? 'cancelled' : !failure && result?.code === 0 ? 'completed' : 'failed'
    const output = redactSensitiveText(
      [result?.stdout, result?.stderr, failure].filter(Boolean).join('\n')
    )
    const finished: BackgroundShellJob = {
      ...job,
      state,
      completedAt: new Date().toISOString(),
      ...(typeof result?.code === 'number' ? { exitCode: result.code } : {}),
      ...(output ? { output: output.slice(0, OUTPUT_PREVIEW_LENGTH) } : {}),
      ...(result?.truncated ? { outputTruncated: true } : {})
    }
    this.retainOutput(finished, output)
    this.active.delete(job.jobId)
    this.recent.unshift(finished)
    if (this.recent.length > MAX_RECENT_JOBS) this.recent.pop()
    this.options.publish({ type: 'shell_job_finished', shellJob: finished })
  }

  private retainOutput(job: BackgroundShellJob, output: string): void {
    if (output.length > OUTPUT_PREVIEW_LENGTH) {
      try {
        const path = this.options.storeOutput(job, output)
        if (path) job.outputPath = path
      } catch (error) {
        this.options.onError(error)
      }
    }
  }
}
