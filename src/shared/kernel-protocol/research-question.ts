export const MAX_RESEARCH_QUESTION_LENGTH = 1000

export function isResearchQuestion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_RESEARCH_QUESTION_LENGTH &&
    value.trim().length > 0
  )
}
