import { decodeXmlEntities, normalizeXmlText, uniqueStrings } from './entrez-utils'

interface PubmedFetchDetails {
  abstract?: string
  mesh_terms?: string[]
  keywords?: string[]
  publication_types?: string[]
}

export function addPubmedFetchDetails(
  rows: Record<string, unknown>[],
  xml: string
): Record<string, unknown>[] {
  const details = parsePubmedFetchXml(xml)
  return rows.map((row) => {
    const match = typeof row.uid === 'string' ? details.get(row.uid) : undefined
    return match ? mergePubmedDetails(row, match) : row
  })
}

function mergePubmedDetails(
  row: Record<string, unknown>,
  details: PubmedFetchDetails
): Record<string, unknown> {
  const merged = { ...row }
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (merged[key] === undefined || merged[key] === '') merged[key] = value
  }
  return merged
}

function parsePubmedFetchXml(xml: string): Map<string, PubmedFetchDetails> {
  const details = new Map<string, PubmedFetchDetails>()
  for (const articleMatch of xml.matchAll(/<PubmedArticle\b[\s\S]*?<\/PubmedArticle>/g)) {
    const article = articleMatch[0]
    const pmid = article.match(/<PMID\b[^>]*>([\s\S]*?)<\/PMID>/)?.[1]?.trim()
    if (!pmid) continue
    const parsed: PubmedFetchDetails = {
      abstract: parsePubmedAbstract(article),
      mesh_terms: uniqueStrings(
        [...article.matchAll(/<DescriptorName\b[^>]*>([\s\S]*?)<\/DescriptorName>/g)]
          .map((match) => normalizeXmlText(match[1]))
          .filter(Boolean)
      ),
      keywords: uniqueStrings(
        [...article.matchAll(/<Keyword\b[^>]*>([\s\S]*?)<\/Keyword>/g)]
          .map((match) => normalizeXmlText(match[1]))
          .filter(Boolean)
      ),
      publication_types: uniqueStrings(
        [...article.matchAll(/<PublicationType\b[^>]*>([\s\S]*?)<\/PublicationType>/g)]
          .map((match) => normalizeXmlText(match[1]))
          .filter(Boolean)
      )
    }
    details.set(pmid, parsed)
  }
  return details
}

function parsePubmedAbstract(article: string): string | undefined {
  const parts = [...article.matchAll(/<AbstractText\b([^>]*)>([\s\S]*?)<\/AbstractText>/g)]
    .map((match) => {
      const label = match[1].match(/\bLabel="([^"]+)"/)?.[1]
      const text = normalizeXmlText(match[2])
      if (!text) return undefined
      return label ? `${decodeXmlEntities(label)}: ${text}` : text
    })
    .filter((item): item is string => item !== undefined)
  return parts.length > 0 ? parts.join('\n') : undefined
}
