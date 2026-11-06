import type {
  BackgroundAgentJob,
  BackgroundShellJob,
  ShellJobFinishedEvent
} from '../../../shared/backgroundJobTypes'
import { appendSessionEvent, findPhiSessionById, persistToolOutput } from '../session/session-store'
import { MAX_AUTOMATIC_CONTINUATIONS } from '../wrappers/composition/job-continue'
import {
  listBackgroundAgentJobs,
  type BackgroundAgentJobListingOptions
} from './background-agent-job-listing'
import {
  listBackgroundShellJobs,
  stopBackgroundShellJob,
  type BackgroundShellJobOperationsOptions
} from './background-shell-job-operations'
import { ChatShellJobs } from './chat-shell-jobs'
import { resolveChatShellOrigin } from './chat-shell-origin'

interface BackgroundJobOperationsOptions {
  agents: BackgroundAgentJobListingOptions
  shell: BackgroundShellJobOperationsOptions
  sendToWindow: (event: Record<string, unknown>) => void
  continueConversation: (sessionId: string, event: ShellJobFinishedEvent) => void
  automaticCount: (sessionId: string) => number
  onError: (error: unknown) => void
}

export interface BackgroundJobOperations {
  listAgentJobs: () => Promise<BackgroundAgentJob[]>
  listShellJobs: () => Promise<BackgroundShellJob[]>
  startShellJob: (request: unknown) => BackgroundShellJob
  stopShellJob: (agentSessionId: unknown, jobId: unknown) => Promise<void>
  dispose: () => Promise<void>
}

export function createBackgroundJobOperations(
  options: BackgroundJobOperationsOptions
): BackgroundJobOperations {
  const chatShellJobs = new ChatShellJobs({
    resolveOrigin: resolveChatShellOrigin,
    publish: (event) => {
      const phiSessionId = event.shellJob.sessionId
      if (!findPhiSessionById(phiSessionId)) return
      const stored = appendSessionEvent(phiSessionId, { ...event })
      options.sendToWindow({ ...stored, phiSessionId })
      if (
        event.type === 'shell_job_finished' &&
        event.shellJob.state !== 'cancelled' &&
        options.automaticCount(phiSessionId) < MAX_AUTOMATIC_CONTINUATIONS
      ) {
        options.continueConversation(phiSessionId, event)
      }
    },
    storeOutput: (job, output) => {
      if (!findPhiSessionById(job.sessionId)) return undefined
      return persistToolOutput(job.sessionId, {
        runId: 'chat-shell',
        toolCallId: job.jobId,
        output,
        inlineLimit: 0
      }).outputPath
    },
    onError: options.onError
  })

  return {
    listAgentJobs: () => listBackgroundAgentJobs(options.agents),
    listShellJobs: async () => {
      const runtimeJobs = await listBackgroundShellJobs(options.shell).catch((error: unknown) => {
        if (chatShellJobs.list().length === 0) throw error
        return []
      })
      return [...chatShellJobs.list(), ...runtimeJobs].sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt)
      )
    },
    startShellJob: (request: unknown) => chatShellJobs.start(request),
    stopShellJob: async (agentSessionId: unknown, jobId: unknown) => {
      if (await chatShellJobs.stop(agentSessionId, jobId)) return
      await stopBackgroundShellJob(agentSessionId, jobId)
    },
    dispose: () => chatShellJobs.dispose()
  }
}
