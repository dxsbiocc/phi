import type { PhiTool } from '../engine/types'

/** The remote guard releases `learn` only for a registration carrying this exact text. */
export const PHI_LEARN_DESCRIPTION =
  "Record one durable lesson in this project's memory so later sessions start with it: a non-obvious fix, a project convention, or a user preference you confirmed. Write it self-contained (what, when, why). Capture sparingly; one specific lesson beats several vague ones. Never record secrets, credentials, or personal data. The user can review and delete every lesson in Phi's settings. Lessons are stored on this computer only, never on a remote server."

const MAX_LESSON_CHARS = 2000
const MAX_CONTEXT_CHARS = 400

export interface LearnedLessonInput {
  content: string
  context?: string
}

export type SaveLearnedLesson = (input: LearnedLessonInput) => Promise<{ stored: number }>

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
    async execute(_toolCallId, params) {
      const record = (params ?? {}) as Record<string, unknown>
      const content = typeof record.memory === 'string' ? record.memory.trim() : ''
      const context = typeof record.context === 'string' ? record.context.trim() : ''
      if (!content) {
        return { content: [{ type: 'text', text: 'learn：经验内容为空，未记录。' }], isError: true }
      }
      const result = await save({ content, ...(context ? { context } : {}) })
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
