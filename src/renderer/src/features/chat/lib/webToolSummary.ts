import { chatCopy } from './chatCopy'
export type WebToolSummary = { headline: string; query?: string }

export function webToolSummary(toolName: string, argsJson: string): WebToolSummary | null {
  if (toolName !== 'web_fetch' && toolName !== 'web_search') return null
  let args: Record<string, unknown>
  try {
    const parsed = JSON.parse(argsJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    args = parsed as Record<string, unknown>
  } catch {
    return null
  }

  if (toolName === 'web_search') {
    const query = typeof args.query === 'string' ? args.query : args.q
    return typeof query === 'string' && query.trim()
      ? { headline: chatCopy.webSearchValue(query.trim()), query: query.trim() }
      : null
  }

  if (typeof args.url !== 'string') return null
  let url: URL
  try {
    url = new URL(args.url)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const isPubMed = url.hostname === 'pubmed.ncbi.nlm.nih.gov'
  const query = ['term', 'q', 'query', 'search']
    .map((name) => url.searchParams.get(name)?.trim())
    .find((value): value is string => Boolean(value))
  if (query) {
    return {
      headline: chatCopy.valueSearchValue(isPubMed ? 'PubMed' : url.hostname, query),
      query
    }
  }
  const pmid = isPubMed ? /^\/(\d+)\/?$/.exec(url.pathname)?.[1] : undefined
  if (pmid) return { headline: chatCopy.pubMedArticlePMIDValue(pmid) }
  return { headline: chatCopy.readWebpageValueValue(url.hostname, url.pathname) }
}
