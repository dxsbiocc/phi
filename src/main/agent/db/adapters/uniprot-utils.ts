export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined
}

export function nestedArray(value: unknown, key: string): unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : []
}

export function firstNestedString(value: unknown, keys: string[]): string | undefined {
  let current = value
  for (const key of keys) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return stringValue(current)
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]))
}

export function compactRecord(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    const value = row[key]
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete row[key]
  }
  return row
}

export function nonEmptyRecord(row: Record<string, unknown>): boolean {
  return Object.keys(row).length > 0
}

export function parseTotalResults(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function isUniProtResultTruncated(
  nextCursor: string | undefined,
  totalRows: number | undefined,
  returnedRows: number,
  cursor: string | undefined
): boolean {
  if (nextCursor) return true
  return !cursor && totalRows !== undefined && returnedRows < totalRows
}

export function cursorFromLinkHeader(value: string | null): string | undefined {
  if (!value) return undefined
  const nextLink = value
    .split(',')
    .map((part) => part.trim())
    .find((part) => /rel="next"/.test(part))
  const urlText = nextLink?.match(/<([^>]+)>/)?.[1]
  if (!urlText) return undefined
  try {
    return new URL(urlText).searchParams.get('cursor') ?? undefined
  } catch {
    return undefined
  }
}
