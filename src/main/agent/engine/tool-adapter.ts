import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import { pickDeclaredToolInput } from '../remote-workspace-tool-input'
import type { PhiTool, PhiToolContext, PhiToolImage, PhiToolResult, PhiToolUpdate } from './types'

import { isRecord } from '../../../shared/guards'

function sessionBranch(context: unknown): unknown[] {
  if (!isRecord(context) || !isRecord(context.sessionManager)) return []
  const getBranch = context.sessionManager.getBranch
  if (typeof getBranch !== 'function') return []
  const branch: unknown = getBranch.call(context.sessionManager)
  return Array.isArray(branch) ? branch : []
}

function containsUserQuestion(context: unknown, question: string): boolean {
  return sessionBranch(context).some((entry) => {
    if (!isRecord(entry) || entry.type !== 'message' || !isRecord(entry.message)) return false
    if (
      entry.message.role !== 'user' ||
      entry.message.synthetic === true ||
      entry.message.attribution === 'agent'
    )
      return false
    const content = entry.message.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string'
              )
              .map((part) => part.text)
              .join('\n')
          : ''
    // Older wake-ups and replan prompts use the user role and may quote child reports.
    return (
      !/^\s*<phi_(?:(?:agent_run|plan_run|wrapper_run|shell_jobs)_finished|research_plan_paused)>/.test(
        text
      ) &&
      !text.startsWith('Replan the remaining steps of paused plan run ') &&
      text.includes(question)
    )
  })
}

export function createPhiToolContext(cwd: string, context: unknown): PhiToolContext {
  return {
    cwd,
    recentUserImages: () => recentUserImages(context),
    containsUserQuestion: (question) => containsUserQuestion(context, question)
  }
}

export function recentUserImages(context: unknown): PhiToolImage[] {
  const branch = sessionBranch(context)
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
        (part): part is PhiToolImage =>
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

export function toOmpCustomTool(tool: PhiTool): CustomTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    ...(tool.hidden === undefined ? {} : { hidden: tool.hidden }),
    ...(tool.loadMode === undefined ? {} : { loadMode: tool.loadMode }),
    ...(tool.approval === undefined ? {} : { approval: tool.approval }),
    ...(tool.lenientArgValidation === undefined
      ? {}
      : { lenientArgValidation: tool.lenientArgValidation }),
    async execute(toolCallId, params, onUpdate, ctx, signal) {
      return tool.execute(
        toolCallId,
        pickDeclaredToolInput(params, tool.parameters),
        onUpdate as PhiToolUpdate | undefined,
        createPhiToolContext(ctx.sessionManager.getCwd(), ctx),
        signal
      ) as Promise<PhiToolResult>
    }
  } as CustomTool
}
