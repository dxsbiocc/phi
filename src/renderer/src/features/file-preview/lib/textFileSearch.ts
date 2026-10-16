export type TextFileMatch = { from: number; to: number }
export const TEXT_SEARCH_MATCH_LIMIT = 10_000

export function findTextFileMatches(
  text: string,
  query: string,
  caseSensitive = false
): {
  matches: TextFileMatch[]
  limited: boolean
} {
  if (!query) return { matches: [], limited: false }
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    caseSensitive ? 'gu' : 'giu'
  )
  const matches: TextFileMatch[] = []
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (matches.length === TEXT_SEARCH_MATCH_LIMIT) return { matches, limited: true }
    matches.push({ from: match.index, to: match.index + match[0].length })
  }
  return { matches, limited: false }
}

export function nextTextFileMatch(count: number, current: number, direction: 1 | -1): number {
  if (!count) return -1
  if (current < 0 || current >= count) return direction === 1 ? 0 : count - 1
  return (current + direction + count) % count
}
