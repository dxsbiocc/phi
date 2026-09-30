import type { CustomTool } from '@oh-my-pi/pi-coding-agent'
import { readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'

import type { PhiAgentDefinition } from './definition'
import { AgentRunLimitError, AgentRunRegistry, type AgentRunSnapshot } from './registry'
import {
  describeToolStart,
  type AgentImage,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunToolStep
} from './runner'

const MAX_TASK_LENGTH = 20000
const MAX_FORWARDED_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

export type AgentRunner = (request: AgentRunRequest) => Promise<AgentRunResult>

export interface AgentToolOptions {
  cwd?: string
  /** Remote projects keep today's delegation tool: no local execution context and no image forwarding. */
  remote?: boolean
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

function latestUserImages(context: unknown): AgentImage[] {
  if (!isRecord(context) || !isRecord(context.sessionManager)) return []
  const getBranch = context.sessionManager.getBranch
  if (typeof getBranch !== 'function') return []
  const branch: unknown = getBranch.call(context.sessionManager)
  if (!Array.isArray(branch)) return []
  let userMessages = 0
  for (let index = branch.length - 1; index >= 0 && userMessages < 3; index -= 1) {
    const entry = branch[index]
    if (!isRecord(entry) || entry.type !== 'message' || !isRecord(entry.message)) continue
    if (entry.message.role !== 'user') continue
    userMessages += 1
    const content = entry.message.content
    if (!Array.isArray(content)) continue
    const images = content
      .filter(
        (part): part is AgentImage =>
          isRecord(part) &&
          part.type === 'image' &&
          typeof part.data === 'string' &&
          part.data.length > 0 &&
          typeof part.mimeType === 'string' &&
          ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(part.mimeType)
      )
      .slice(0, 5)
    if (images.length > 0) return images
  }
  return []
}

function imagePathsFrom(params: Record<string, unknown>): string[] | string {
  if (params.image_paths === undefined) return []
  if (!Array.isArray(params.image_paths)) return 'image_paths must be an absolute file path.'
  const paths: string[] = []
  for (const item of params.image_paths) {
    if (typeof item !== 'string' || !isAbsolute(item.trim())) {
      return 'image_paths must be an absolute file path.'
    }
    paths.push(item.trim())
  }
  return paths
}

function imageFromFile(filePath: string): AgentImage | string {
  const mimeType = IMAGE_MIME[extname(filePath).toLowerCase()]
  if (!mimeType) return `Cannot forward image file: ${filePath}`
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return `Cannot forward image file: ${filePath}`
    if (stat.size > MAX_FORWARDED_IMAGE_BYTES) {
      return `Image file is larger than 20 MB and cannot be forwarded: ${filePath}`
    }
    const data = readFileSync(filePath).toString('base64')
    if (!data) return `Cannot forward image file: ${filePath}`
    return { type: 'image', data, mimeType }
  } catch {
    return `Cannot forward image file: ${filePath}`
  }
}

function executionContext(task: string, cwd: string | undefined, notes: string[]): string {
  if (!cwd && notes.length === 0) return task
  return [
    'Phi execution context:',
    ...(cwd
      ? [
          `- Current project working directory (cwd): ${cwd}`,
          '- All generated files must stay under this cwd so Phi can preview and open them.',
          '- Treat input/data paths outside cwd as read-only. Do not create sibling outputs beside external input data.',
          '- Return cwd-contained paths in the final report.'
        ]
      : []),
    ...notes,
    '',
    'Delegated task:',
    task
  ].join('\n')
}

function delegationDescription(definition: PhiAgentDefinition, options: AgentToolOptions): string {
  const local = options.remote !== true
  const cwd = options.cwd?.trim()
  const images = local
    ? ' Set `image_paths` to absolute paths of image files to forward, or `include_attached_images` to forward the latest user-attached images.'
    : ''
  const boundary =
    local && cwd
      ? `\n\nProject output boundary: generated files must stay under the current project working directory (${cwd}). Paths outside it are read-only inputs. Return cwd-contained paths.`
      : ''
  return `${definition.description}\n\nHands the task to the ${definition.name} agent, a specialist with its own tools and its own session. It cannot see this conversation and cannot ask the user questions, so write \`task\` as a complete, self-contained request: absolute file paths, where outputs should go, and any user preferences. It returns a short report. Independent tasks can be delegated in the same turn and run in parallel; set \`background\` to carry on while it works.${images}${boundary}`
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
  const local = options.remote !== true
  const cwd = options.cwd?.trim()
  return {
    name,
    label: name,
    description: delegationDescription(definition, options),
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description: `Self-contained instruction for the ${name} agent.`
        },
        ...(local
          ? {
              image_paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Absolute paths of image files to forward to the specialist.'
              },
              include_attached_images: {
                type: 'boolean',
                description: 'Forward the latest user-attached images to the specialist.'
              }
            }
          : {}),
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
    async execute(toolCallId, params, onUpdate, ctx, signal) {
      const rawTask = isRecord(params) ? params.task : undefined
      const task = typeof rawTask === 'string' ? rawTask.trim() : ''
      if (!task) return errorResult('Missing required parameter: task')
      if (task.length > MAX_TASK_LENGTH) {
        return errorResult(
          `task is too long (${task.length} characters; the limit is ${MAX_TASK_LENGTH}).`
        )
      }
      const record = isRecord(params) ? params : {}
      let images: AgentImage[] = []
      const notes: string[] = []
      if (local) {
        const paths = imagePathsFrom(record)
        if (typeof paths === 'string') return errorResult(paths)
        const loaded: AgentImage[] = []
        for (const filePath of paths) {
          const image = imageFromFile(filePath)
          if (typeof image === 'string') return errorResult(image)
          loaded.push(image)
        }
        const includeAttached = record.include_attached_images === true
        const attached = includeAttached ? latestUserImages(ctx) : []
        if (includeAttached && attached.length === 0 && paths.length === 0) {
          return errorResult(
            'The reference image is missing. Attach it or provide an image file path.'
          )
        }
        images = [...loaded, ...attached]
        if (paths.length > 0) notes.push(`- Image file paths: ${paths.join(', ')}`)
        if (attached.length > 0) {
          notes.push('- User-attached images are attached to this prompt.')
        }
      }
      const background = record.background === true
      const delegatedTask = executionContext(task, local ? cwd : undefined, notes)

      let handle
      try {
        handle = registry.launch({
          agent: name,
          task: delegatedTask,
          ...(images.length > 0 ? { images } : {}),
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
