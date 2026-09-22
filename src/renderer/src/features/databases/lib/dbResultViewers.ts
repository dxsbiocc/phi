import type { DbQueryToolDetails, DbResultViewerHint } from '../../../../../shared/dbConnectorTypes'
import { stripSavedOutputMarker } from '../../../lib/toolOutputPresentation'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDbQueryToolDetails(value: unknown): value is DbQueryToolDetails {
  return isRecord(value) && value.kind === 'db_query_result'
}

export function dbQueryDetailsFromToolOutput(output: string): DbQueryToolDetails | null {
  const text = stripSavedOutputMarker(output).trim()
  if (!text.startsWith('{') || !text.endsWith('}')) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return isDbQueryToolDetails(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function dbResultViewerHintsFromToolOutput(output: string): DbResultViewerHint[] {
  return dbQueryDetailsFromToolOutput(output)?.viewerHints ?? []
}
