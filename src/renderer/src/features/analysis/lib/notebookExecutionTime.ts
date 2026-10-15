import type { JsonObject } from '../../../../../shared/notebookDocument'

export function notebookExecutionCompletedAt(metadata: JsonObject): string | undefined {
  const phi = metadata.phi
  if (!phi || typeof phi !== 'object' || Array.isArray(phi)) return undefined
  const completedAt = phi.executionCompletedAt
  return typeof completedAt === 'string' && Number.isFinite(Date.parse(completedAt))
    ? completedAt
    : undefined
}

export function formatNotebookExecutionCompletedAt(completedAt?: string): string | null {
  if (!completedAt) return null
  const date = new Date(completedAt)
  if (!Number.isFinite(date.getTime())) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `${day} ${time}`
}
