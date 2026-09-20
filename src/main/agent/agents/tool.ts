import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import type { PhiAgentDefinition } from './definition'
import {
  AgentCancelledError,
  AgentTimeoutError,
  type AgentRunRequest,
  type AgentRunResult
} from './runner'

const MAX_TASK_LENGTH = 20000

export type AgentRunner = (request: AgentRunRequest) => Promise<AgentRunResult>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorResult(text: string): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * The delegation tool for one scanned agent. The tool IS the agent: it is
 * named exactly `definition.name` (e.g. `Wrapper`), so the main agent hands
 * work to an agent by name. The agent runs in its own session with its own
 * tools; only its short final report comes back into the main conversation.
 */
export function buildAgentTool(definition: PhiAgentDefinition, runner: AgentRunner): CustomTool {
  const { name } = definition
  return {
    name,
    label: name,
    description: `${definition.description}\n\nHands the task to the ${name} agent, a specialist with its own tools and its own session. It cannot see this conversation and cannot ask the user questions, so write \`task\` as a complete, self-contained request: absolute file paths, where outputs should go, and any user preferences. It returns a short report.`,
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description: `Self-contained instruction for the ${name} agent.`
        }
      }
    },
    // Custom tools default to "discoverable" (hidden behind `read xd://`). The
    // leader has to see its delegation tools at all times.
    loadMode: 'essential',
    // The delegation itself changes nothing; each write/exec the agent makes is
    // approved individually through the same approval channel.
    approval: 'read',
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const rawTask = isRecord(params) ? params.task : undefined
      const task = typeof rawTask === 'string' ? rawTask.trim() : ''
      if (!task) return errorResult('Missing required parameter: task')
      if (task.length > MAX_TASK_LENGTH) {
        return errorResult(
          `task is too long (${task.length} characters; the limit is ${MAX_TASK_LENGTH}).`
        )
      }

      try {
        const result = await runner({
          task,
          signal,
          onProgress: (line) =>
            onUpdate?.({
              content: [{ type: 'text', text: line }],
              details: { kind: 'agent_progress', agent: name }
            })
        })
        const report = result.text.trim()
        if (!report) {
          return errorResult(
            `The ${name} agent finished but produced no report. Try again with a more specific task.`
          )
        }
        return {
          content: [{ type: 'text', text: report }],
          details: { kind: 'agent_result', agent: name, toolCalls: result.toolCalls }
        }
      } catch (error) {
        if (error instanceof AgentCancelledError || error instanceof AgentTimeoutError) {
          return errorResult(error.message)
        }
        return errorResult(
          `The ${name} agent failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }
}
