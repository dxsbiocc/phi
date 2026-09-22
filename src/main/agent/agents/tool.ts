import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import type { PhiAgentDefinition } from './definition'
import { AgentRunLimitError, AgentRunRegistry, type AgentRunSnapshot } from './registry'
import {
  describeToolStart,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunToolStep
} from './runner'

const MAX_TASK_LENGTH = 20000

export type AgentRunner = (request: AgentRunRequest) => Promise<AgentRunResult>

export interface AgentToolOptions {
  cwd?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorResult(text: string): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return { content: [{ type: 'text', text }], isError: true }
}

function stepUpdateText(step: AgentRunToolStep): string {
  if (step.status === 'running' && step.args !== undefined) {
    return describeToolStart(step.toolName, step.args)
  }
  if (step.status === 'error') return `${step.toolName} 失败`
  if (step.status === 'done') return `${step.toolName} 完成`
  return step.toolName
}

function reportForMain(run: AgentRunSnapshot): string {
  const report = run.report ?? ''
  const status = run.reportStatus ?? 'completed'
  if (status === 'completed') return report

  const metadata = [`Specialist outcome: ${status}.`]
  if (run.missingInputs?.length) metadata.push(`Missing inputs: ${run.missingInputs.join('; ')}`)
  if (run.nextAgent) metadata.push(`Suggested next agent: ${run.nextAgent}.`)
  if (run.fallbackReason) metadata.push(`Fallback reason: ${run.fallbackReason}.`)
  return `${metadata.join('\n')}\n\n${report}`.trim()
}

function isVisualizationAgent(definition: PhiAgentDefinition): boolean {
  return (
    definition.name === 'Visualization' ||
    definition.skills.includes('omics-visualization') ||
    definition.description.toLowerCase().includes('omics')
  )
}

function projectBoundaryDescription(
  definition: PhiAgentDefinition,
  options: AgentToolOptions
): string {
  const cwd = options.cwd?.trim()
  if (!cwd || !isVisualizationAgent(definition)) return ''

  return `\n\nProject output boundary for Visualization: generated figures, copied template source, scratch scripts, reports, and QA artifacts must be written under the current project working directory (${cwd}). Treat data paths outside that directory as read-only inputs. If no output directory is specified, use a new directory under ${cwd}/visualizations/ or ${cwd}/plots/.`
}

function taskWithProjectBoundary(
  definition: PhiAgentDefinition,
  task: string,
  options: AgentToolOptions
): string {
  const cwd = options.cwd?.trim()
  if (!cwd || !isVisualizationAgent(definition)) return task

  return [
    'Phi execution context:',
    `- Current project working directory (cwd): ${cwd}`,
    '- All generated files must stay under this cwd so Phi can preview and open them.',
    '- Treat input/data paths outside cwd as read-only. Do not create sibling plots, scripts, or reports beside external input data.',
    '- If the user did not specify an output directory, create a concise subdirectory under cwd, for example visualizations/<short-task-name>/ or plots/<short-task-name>/.',
    '- Return cwd-contained artifact paths in the final report.',
    '',
    'Delegated task:',
    task
  ].join('\n')
}

/**
 * The delegation tool for one scanned agent. The tool IS the agent: it is
 * named exactly `definition.name` (e.g. `Wrapper`), so the main agent hands
 * work to an agent by name. The agent runs in its own session with its own
 * tools; only its short final report comes back into the main conversation.
 *
 * Every run goes through the conversation's `registry`. Calls made in the same
 * turn run in parallel (up to the registry's limit), and `background: true`
 * returns a run id at once instead of waiting, to be collected with the run tools.
 */
export function buildAgentTool(
  definition: PhiAgentDefinition,
  runner: AgentRunner,
  registry: AgentRunRegistry = new AgentRunRegistry(),
  options: AgentToolOptions = {}
): CustomTool {
  const { name } = definition
  return {
    name,
    label: name,
    description: `${definition.description}\n\nHands the task to the ${name} agent, a specialist with its own tools and its own session. It cannot see this conversation and cannot ask the user questions, so write \`task\` as a complete, self-contained request: absolute file paths, where outputs should go, and any user preferences. It returns a short report. Independent tasks can be delegated in the same turn and run in parallel; set \`background\` to carry on while it works.${projectBoundaryDescription(definition, options)}`,
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description: `Self-contained instruction for the ${name} agent.`
        },
        background: {
          type: 'boolean',
          description:
            'Start the run in the background and return its run id at once, so you can continue with other work. Phi hands you the report when it finishes. Use it for long or independent tasks.'
        }
      }
    },
    // Custom tools default to "discoverable" (hidden behind `read xd://`). The
    // leader has to see its delegation tools at all times.
    loadMode: 'essential',
    // The delegation itself changes nothing; each write/exec the agent makes is
    // approved individually through the same approval channel.
    approval: 'read',
    async execute(toolCallId, params, onUpdate, _ctx, signal) {
      const rawTask = isRecord(params) ? params.task : undefined
      const task = typeof rawTask === 'string' ? rawTask.trim() : ''
      if (!task) return errorResult('Missing required parameter: task')
      if (task.length > MAX_TASK_LENGTH) {
        return errorResult(
          `task is too long (${task.length} characters; the limit is ${MAX_TASK_LENGTH}).`
        )
      }
      const background = isRecord(params) && params.background === true
      const delegatedTask = taskWithProjectBoundary(definition, task, options)

      let handle
      try {
        handle = registry.launch({
          agent: name,
          task: delegatedTask,
          runner,
          background,
          ...(signal ? { signal } : {}),
          ...(typeof toolCallId === 'string' && toolCallId ? { toolCallId } : {}),
          // A background run outlives this tool call, so it must not report through it.
          ...(background
            ? {}
            : {
                onProgress: (line: string, agentRunId: string) =>
                  onUpdate?.({
                    content: [{ type: 'text', text: line }],
                    details: { kind: 'agent_progress', agent: name, agentRunId }
                  }),
                onToolStep: (step: AgentRunToolStep, agentRunId: string) =>
                  onUpdate?.({
                    content: [{ type: 'text', text: stepUpdateText(step) }],
                    details: { kind: 'agent_step', agent: name, agentRunId, step }
                  })
              })
        })
      } catch (error) {
        if (error instanceof AgentRunLimitError) return errorResult(error.message)
        throw error
      }

      if (background) {
        return {
          content: [
            {
              type: 'text',
              text: `Started the ${name} agent in the background as run ${handle.id}. It keeps working while you continue, and Phi sends you its report as a message when it finishes, so do not poll. Call agent_wait ids=["${handle.id}"] only if you cannot go on without the result; agent_status shows progress, agent_steer redirects it, agent_stop cancels it.`
            }
          ],
          details: { kind: 'agent_started', agent: name, runId: handle.id }
        }
      }

      const run = await handle.done
      if (run.state !== 'done') {
        return errorResult(run.error ?? `The ${name} agent did not finish.`)
      }
      return {
        content: [{ type: 'text', text: reportForMain(run) }],
        details: {
          kind: 'agent_result',
          agent: name,
          status: run.reportStatus ?? 'completed',
          missingInputs: run.missingInputs ?? [],
          ...(run.nextAgent ? { nextAgent: run.nextAgent } : {}),
          ...(run.fallbackReason ? { fallbackReason: run.fallbackReason } : {}),
          toolCalls: run.toolCalls ?? 0
        }
      }
    }
  }
}
