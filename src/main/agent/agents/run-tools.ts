import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import { isFinalAgentRunState, type AgentRunRegistry, type AgentRunSnapshot } from './registry'

const DEFAULT_WAIT_SECONDS = 120
const MAX_WAIT_SECONDS = 600
const MAX_REPORT_LENGTH = 20000
const MAX_TASK_PREVIEW = 100

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] }
}

function errorResult(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }], isError: true }
}

function stringParam(params: unknown, key: string): string {
  const value = isRecord(params) ? params[key] : undefined
  return typeof value === 'string' ? value.trim() : ''
}

function elapsed(run: AgentRunSnapshot, now: number): string {
  const seconds = Math.max(0, Math.round(((run.completedAt ?? now) - run.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes}m${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

function oneLine(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function describeRun(run: AgentRunSnapshot, now: number): string {
  const lines = [
    `- ${run.id} · ${run.agent} · ${run.state}${run.background ? ' (background)' : ''} · ${elapsed(run, now)}`,
    `  task: ${oneLine(run.task, MAX_TASK_PREVIEW)}`
  ]
  if (run.state === 'running' && run.lastStep) lines.push(`  doing: ${run.lastStep}`)
  if (run.reportStatus && run.reportStatus !== 'completed') {
    lines.push(`  outcome: ${run.reportStatus}`)
  }
  if (run.missingInputs?.length) lines.push(`  missing: ${run.missingInputs.join('; ')}`)
  if (run.nextAgent) lines.push(`  next agent: ${run.nextAgent}`)
  if (run.fallbackReason) lines.push(`  fallback reason: ${run.fallbackReason}`)
  if (run.error) lines.push(`  ${run.error}`)
  return lines.join('\n')
}

function withReport(run: AgentRunSnapshot, now: number): string {
  const head = describeRun(run, now)
  if (!run.report) return head
  const report =
    run.report.length > MAX_REPORT_LENGTH
      ? `${run.report.slice(0, MAX_REPORT_LENGTH)}\n… (report truncated)`
      : run.report
  return `${head}\n  report:\n${report}`
}

function idList(params: unknown): string[] | undefined {
  const value = isRecord(params) ? params.ids : undefined
  if (!Array.isArray(value)) return undefined
  const ids = value.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
  return ids.length > 0 ? ids.map((id) => id.trim()) : undefined
}

function waitSeconds(params: unknown): number {
  const value = isRecord(params) ? params.timeout_seconds : undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return DEFAULT_WAIT_SECONDS
  return Math.min(value, MAX_WAIT_SECONDS)
}

function tool(
  name: string,
  description: string,
  parameters: CustomTool['parameters'],
  execute: (params: unknown, signal: AbortSignal | undefined) => Promise<ToolResult>
): CustomTool {
  return {
    name,
    label: name,
    description,
    parameters,
    // The leader has to see these at all times, and they only manage runs it already started.
    loadMode: 'essential',
    approval: 'read',
    async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
      return execute(params, signal)
    }
  }
}

/**
 * The main agent's handles on its specialists' runs: look at them, wait for
 * them, redirect one mid-flight, or cancel it. They only ever act on runs that
 * this conversation started through a delegation tool.
 */
export function buildAgentRunTools(registry: AgentRunRegistry): CustomTool[] {
  const status = tool(
    'agent_status',
    'Shows the agent runs of this conversation (id, agent, state, what each is doing). Pass `id` to see one run in full, including its report once it has finished.',
    {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A run id such as run_1. Omit to list every run.' }
      }
    },
    async (params) => {
      const now = Date.now()
      const id = stringParam(params, 'id')
      if (id) {
        const run = registry.get(id)
        if (!run) return errorResult(`Unknown run: ${id}`)
        registry.markReported(id)
        return text(withReport(run, now))
      }
      const runs = registry.list()
      if (runs.length === 0) return text('No agent runs in this conversation yet.')
      return text(runs.map((run) => describeRun(run, now)).join('\n'))
    }
  )

  const wait = tool(
    'agent_wait',
    'Waits for agent runs to finish and returns their reports. Use it to collect background runs. Gives up after `timeout_seconds` (default 120, at most 600) and tells you which runs are still running; the runs keep going, so you can wait again.',
    {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Run ids to wait for. Omit to wait for every unfinished run.'
        },
        timeout_seconds: { type: 'number', description: 'How long to wait, in seconds.' },
        mode: {
          type: 'string',
          enum: ['all', 'any'],
          description: '`all` (default) waits for every run; `any` returns when the first finishes.'
        }
      }
    },
    async (params, signal) => {
      const mode = isRecord(params) && params.mode === 'any' ? 'any' : 'all'
      let result
      try {
        result = await registry.wait(idList(params), {
          timeoutMs: waitSeconds(params) * 1000,
          mode,
          ...(signal ? { signal } : {})
        })
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
      if (result.runs.length === 0) return text('There are no unfinished agent runs to wait for.')

      const now = Date.now()
      for (const run of result.runs) registry.markReported(run.id)
      const lines = result.runs.map((run) => withReport(run, now))
      const pending = result.runs.filter((run) => !isFinalAgentRunState(run.state))
      if (pending.length > 0) {
        lines.push(
          `${pending.length} run(s) still running (${pending.map((run) => run.id).join(', ')}). Wait again, or carry on with other work.`
        )
      }
      return text(lines.join('\n'))
    }
  )

  const steer = tool(
    'agent_steer',
    'Sends a message to a running agent. It reads it after its current tool call and adjusts course, so use it to correct or refine a run without restarting it. Write the message as an instruction to that agent.',
    {
      type: 'object',
      required: ['id', 'message'],
      properties: {
        id: { type: 'string', description: 'The run id.' },
        message: { type: 'string', description: 'What the agent should do differently.' }
      }
    },
    async (params) => {
      const id = stringParam(params, 'id')
      const message = stringParam(params, 'message')
      if (!id) return errorResult('Missing required parameter: id')
      if (!message) return errorResult('Missing required parameter: message')
      try {
        await registry.steer(id, message)
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
      return text(`Sent your message to ${id}. It will read it after its current tool call.`)
    }
  )

  const stop = tool(
    'agent_stop',
    'Cancels a queued or running agent run. Work it already did (files written, jobs started) is not undone.',
    {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: 'The run id.' } }
    },
    async (params) => {
      const id = stringParam(params, 'id')
      if (!id) return errorResult('Missing required parameter: id')
      const run = registry.get(id)
      if (!run) return errorResult(`Unknown run: ${id}`)
      if (!registry.stop(id)) return errorResult(`Run ${id} has already finished (${run.state}).`)
      return text(`Stopping ${id} (${run.agent}).`)
    }
  )

  return [status, wait, steer, stop]
}
