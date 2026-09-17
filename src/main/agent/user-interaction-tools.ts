import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import type {
  AgentUserInteractionAnswer,
  AgentUserInteractionQuestion,
  AgentUserInteractionResponse
} from '../../shared/agentInteractionTypes'

const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question'
const MAX_QUESTIONS = 4
const MIN_OPTIONS = 2
const MAX_OPTIONS = 4
const MAX_HEADER_LENGTH = 16
const MAX_LABEL_LENGTH = 60
const RESERVED_LABELS = ['Other', 'Type something.', 'Next'] as const
const RESERVED_LABEL_SET = new Set<string>(RESERVED_LABELS)

const DECLINE_MESSAGE = 'User declined to answer questions'
const ENVELOPE_PREFIX = 'User has answered your questions:'
const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind."
const NO_INPUT_PLACEHOLDER = '(no input)'

type QuestionnaireError =
  | 'no_questions'
  | 'empty_options'
  | 'too_many_questions'
  | 'too_many_options'
  | 'invalid_question'
  | 'duplicate_question'
  | 'duplicate_option_label'
  | 'reserved_label'

type QuestionnaireResult = Omit<AgentUserInteractionResponse, 'requestId'>

export type UserInteractionToolRequest = {
  runtimeSessionId: string
  questions: AgentUserInteractionQuestion[]
}

export type UserInteractionToolHostExecutor = (
  request: UserInteractionToolRequest
) => Promise<unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeLineTerminators(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '')
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? normalizeLineTerminators(value) : ''
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? normalizeLineTerminators(value) : undefined
}

function questionParamsFrom(value: unknown): { questions: AgentUserInteractionQuestion[] } {
  const record = isRecord(value) ? value : {}
  const rawQuestions = Array.isArray(record.questions) ? record.questions : []
  return {
    questions: rawQuestions.filter(isRecord).map((question) => ({
      question: stringField(question, 'question'),
      header: stringField(question, 'header'),
      options: (Array.isArray(question.options) ? question.options : [])
        .filter(isRecord)
        .map((option) => ({
          label: stringField(option, 'label'),
          description: stringField(option, 'description'),
          ...(optionalStringField(option, 'preview')
            ? { preview: optionalStringField(option, 'preview') }
            : {})
        })),
      ...(question.multiSelect === true ? { multiSelect: true } : {})
    }))
  }
}

function validateQuestionnaire(params: {
  questions: AgentUserInteractionQuestion[]
}): { ok: true } | { ok: false; error: QuestionnaireError; message: string } {
  if (params.questions.length === 0) {
    return { ok: false, error: 'no_questions', message: 'Error: At least one question is required' }
  }
  if (params.questions.length > MAX_QUESTIONS) {
    return {
      ok: false,
      error: 'too_many_questions',
      message: `Error: At most ${MAX_QUESTIONS} questions are allowed per invocation`
    }
  }

  const seenQuestions = new Set<string>()
  for (const question of params.questions) {
    if (!question.question || !question.header) {
      return {
        ok: false,
        error: 'invalid_question',
        message: 'Error: Each question requires question and header'
      }
    }
    if (question.header.length > MAX_HEADER_LENGTH) {
      return {
        ok: false,
        error: 'invalid_question',
        message: `Error: Question header must be at most ${MAX_HEADER_LENGTH} characters`
      }
    }
    if (seenQuestions.has(question.question)) {
      return {
        ok: false,
        error: 'duplicate_question',
        message: 'Error: Question text must be unique within an invocation'
      }
    }
    seenQuestions.add(question.question)
  }

  for (const question of params.questions) {
    if (question.options.length < MIN_OPTIONS) {
      return {
        ok: false,
        error: 'empty_options',
        message: `Error: Each question requires at least ${MIN_OPTIONS} options`
      }
    }
    if (question.options.length > MAX_OPTIONS) {
      return {
        ok: false,
        error: 'too_many_options',
        message: `Error: Each question allows at most ${MAX_OPTIONS} options`
      }
    }
    const seenLabels = new Set<string>()
    for (const option of question.options) {
      if (!option.label || !option.description) {
        return {
          ok: false,
          error: 'invalid_question',
          message: 'Error: Each option requires label and description'
        }
      }
      if (option.label.length > MAX_LABEL_LENGTH) {
        return {
          ok: false,
          error: 'invalid_question',
          message: `Error: Option label must be at most ${MAX_LABEL_LENGTH} characters`
        }
      }
      if (RESERVED_LABEL_SET.has(option.label)) {
        return {
          ok: false,
          error: 'reserved_label',
          message: `Error: Option label is reserved (${RESERVED_LABELS.join(', ')})`
        }
      }
      if (seenLabels.has(option.label)) {
        return {
          ok: false,
          error: 'duplicate_option_label',
          message: 'Error: Option labels must be unique within a question'
        }
      }
      seenLabels.add(option.label)
    }
  }

  return { ok: true }
}

function answerFromUnknown(value: unknown): AgentUserInteractionAnswer | null {
  if (!isRecord(value)) return null
  const questionIndex = typeof value.questionIndex === 'number' ? value.questionIndex : null
  const question = typeof value.question === 'string' ? value.question : null
  const kind =
    value.kind === 'option' || value.kind === 'custom' || value.kind === 'multi' ? value.kind : null
  if (questionIndex === null || question === null || kind === null) return null
  const selected = Array.isArray(value.selected)
    ? value.selected.filter((item): item is string => typeof item === 'string')
    : undefined
  return {
    questionIndex,
    question,
    kind,
    answer: typeof value.answer === 'string' ? value.answer : null,
    ...(selected && selected.length > 0 ? { selected } : {}),
    ...(typeof value.notes === 'string' && value.notes.length > 0 ? { notes: value.notes } : {}),
    ...(typeof value.preview === 'string' && value.preview.length > 0
      ? { preview: value.preview }
      : {})
  }
}

function questionnaireResultFrom(value: unknown): QuestionnaireResult {
  if (!isRecord(value)) return { answers: [], cancelled: true }
  const answers = Array.isArray(value.answers)
    ? value.answers
        .map(answerFromUnknown)
        .filter((answer): answer is AgentUserInteractionAnswer => Boolean(answer))
    : []
  return {
    answers,
    cancelled: value.cancelled === true,
    ...(typeof value.globalNote === 'string' && value.globalNote.length > 0
      ? { globalNote: value.globalNote }
      : {}),
    ...(typeof value.error === 'string' && value.error.length > 0 ? { error: value.error } : {})
  }
}

function formatAnswerScalar(answer: AgentUserInteractionAnswer): string {
  if (answer.kind === 'multi') {
    return answer.selected && answer.selected.length > 0
      ? answer.selected.join(', ')
      : NO_INPUT_PLACEHOLDER
  }
  return answer.answer && answer.answer.length > 0 ? answer.answer : NO_INPUT_PLACEHOLDER
}

function buildAnswerSegment(answer: AgentUserInteractionAnswer): string {
  const parts = [`"${answer.question}"="${formatAnswerScalar(answer)}"`]
  if (answer.preview && answer.preview.length > 0) {
    parts.push(`selected preview: ${answer.preview}`)
  }
  if (answer.notes && answer.notes.length > 0) {
    parts.push(`user notes: ${answer.notes}`)
  }
  return `${parts.join('. ')}.`
}

function buildToolResult(
  text: string,
  details: QuestionnaireResult
): {
  content: Array<{ type: 'text'; text: string }>
  details: QuestionnaireResult
} {
  return {
    content: [{ type: 'text', text }],
    details
  }
}

function buildQuestionnaireResponse(
  result: QuestionnaireResult | null | undefined,
  params: { questions: AgentUserInteractionQuestion[] }
): {
  content: Array<{ type: 'text'; text: string }>
  details: QuestionnaireResult
} {
  if (!result || result.cancelled) {
    return buildToolResult(DECLINE_MESSAGE, {
      answers: result?.answers ?? [],
      cancelled: true,
      ...(result?.globalNote ? { globalNote: result.globalNote } : {}),
      ...(result?.error ? { error: result.error } : {})
    })
  }

  const segments: string[] = []
  for (let i = 0; i < params.questions.length; i++) {
    const answer = result.answers.find((item) => item.questionIndex === i)
    if (answer) segments.push(buildAnswerSegment(answer))
  }
  if (result.globalNote && result.globalNote.length > 0) {
    segments.push(`global note: ${result.globalNote}.`)
  }
  if (segments.length === 0) {
    return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true })
  }
  return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(' ')} ${ENVELOPE_SUFFIX}`, result)
}

const TOOL_DESCRIPTION = `Ask the user one or more structured questions during execution. Use this when requirements are ambiguous and you cannot proceed without concrete decisions.

Rules:
- Group all clarifying questions into one invocation; do not stack multiple ask_user_question calls back-to-back.
- Ask 1-${MAX_QUESTIONS} questions. Each question must have ${MIN_OPTIONS}-${MAX_OPTIONS} options.
- Every option needs a concise label and a description explaining the consequence or trade-off.
- Users can type a custom answer through the automatically provided custom-answer field; do not author "Other", "Type something.", or "Next" option labels.
- Set multiSelect: true only when multiple answers are valid.
- Put the recommended option first and append "(Recommended)" to its label when you have a recommendation.
- Use option.preview markdown when the user benefits from comparing code, configs, layouts, or other concrete artifacts.`

export function buildAskUserQuestionCustomTools(
  runtimeSessionId: string,
  executeHost: UserInteractionToolHostExecutor
): CustomTool[] {
  return [
    {
      name: ASK_USER_QUESTION_TOOL_NAME,
      label: 'Ask User Question',
      description: TOOL_DESCRIPTION,
      loadMode: 'essential',
      strict: true,
      parameters: {
        type: 'object',
        required: ['questions'],
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_QUESTIONS,
            description: `Questions to ask the user (1-${MAX_QUESTIONS} questions).`,
            items: {
              type: 'object',
              required: ['question', 'header', 'options'],
              properties: {
                question: {
                  type: 'string',
                  description: 'The complete question to ask the user.'
                },
                header: {
                  type: 'string',
                  maxLength: MAX_HEADER_LENGTH,
                  description: 'Very short chip/tag shown next to the question.'
                },
                options: {
                  type: 'array',
                  minItems: MIN_OPTIONS,
                  maxItems: MAX_OPTIONS,
                  description: `The available choices. Must have ${MIN_OPTIONS}-${MAX_OPTIONS} options.`,
                  items: {
                    type: 'object',
                    required: ['label', 'description'],
                    properties: {
                      label: {
                        type: 'string',
                        maxLength: MAX_LABEL_LENGTH,
                        description: 'Concise display label for the option.'
                      },
                      description: {
                        type: 'string',
                        description: 'Explanation of what the option means or changes.'
                      },
                      preview: {
                        type: 'string',
                        description: 'Optional markdown preview for richer comparisons.'
                      }
                    }
                  }
                },
                multiSelect: {
                  type: 'boolean',
                  description: 'Allow selecting multiple options.'
                }
              }
            }
          }
        }
      },
      approval: 'read',
      async execute(_toolCallId, params) {
        const typed = questionParamsFrom(params)
        const validation = validateQuestionnaire(typed)
        if (!validation.ok) {
          return buildToolResult(validation.message, {
            answers: [],
            cancelled: true,
            error: validation.error
          })
        }

        try {
          const result = questionnaireResultFrom(
            await executeHost({
              runtimeSessionId,
              questions: typed.questions
            })
          )
          return buildQuestionnaireResponse(result, typed)
        } catch (error) {
          return buildToolResult(error instanceof Error ? error.message : String(error), {
            answers: [],
            cancelled: true,
            error: 'no_custom_ui'
          })
        }
      }
    }
  ]
}
