import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import { pickDeclaredToolInput } from '../remote-workspace-tool-input'
import type { PhiTool, PhiToolContext, PhiToolImage, PhiToolResult, PhiToolUpdate } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recentUserImages(context: unknown): PhiToolImage[] {
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
      const phiContext: PhiToolContext = {
        cwd: ctx.sessionManager.getCwd(),
        recentUserImages: () => recentUserImages(ctx)
      }
      return tool.execute(
        toolCallId,
        pickDeclaredToolInput(params, tool.parameters),
        onUpdate as PhiToolUpdate | undefined,
        phiContext,
        signal
      ) as Promise<PhiToolResult>
    }
  } as CustomTool
}
