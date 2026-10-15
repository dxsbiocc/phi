import type { PhiTool } from '../engine/types'
import { PHI_LEARN_DESCRIPTION } from '../engine/phi-extension'

export { PHI_LEARN_DESCRIPTION } from '../engine/phi-extension'

/** The remote guard releases `learn` only for a registration carrying this exact text. */
const MAX_LESSON_CHARS = 2000
const MAX_CONTEXT_CHARS = 400

export interface LearnedLessonInput {
  content: string
  context?: string
}

export type SaveLearnedLesson = (
  input: LearnedLessonInput,
  signal?: AbortSignal
) => Promise<{ stored: number }>

/**
 * Phi's own `learn`: the SDK's autolearn variant would also expose `manage_skill` and
 * write global managed skills, which Phi does not offer.
 */
export function buildProjectLearnTool(save: SaveLearnedLesson): PhiTool {
  return {
    name: 'learn',
    label: '记录经验',
    description: PHI_LEARN_DESCRIPTION,
    site: 'host',
    loadMode: 'essential',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['memory'],
      properties: {
        memory: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_LESSON_CHARS,
          description: 'The durable, self-contained lesson to remember (what, when, why).'
        },
        context: {
          type: 'string',
          maxLength: MAX_CONTEXT_CHARS,
          description: 'Optional short source context for the lesson.'
        }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
      signal?.throwIfAborted()
      const record = (params ?? {}) as Record<string, unknown>
      const content = typeof record.memory === 'string' ? record.memory.trim() : ''
      const context = typeof record.context === 'string' ? record.context.trim() : ''
      if (!content) {
        return { content: [{ type: 'text', text: 'learn：经验内容为空，未记录。' }], isError: true }
      }
      const result = await save({ content, ...(context ? { context } : {}) }, signal)
      signal?.throwIfAborted()
      if (result.stored === 0) {
        return {
          content: [{ type: 'text', text: 'learn：经验在去除敏感内容后为空，未记录。' }],
          isError: true
        }
      }
      return { content: [{ type: 'text', text: '已记录到项目记忆。' }] }
    }
  }
}
