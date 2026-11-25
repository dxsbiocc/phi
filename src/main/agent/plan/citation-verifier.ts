import type {
  LiteratureVerificationStatus,
  PlanLiteratureReviewDecision,
  PlanSpec
} from '../../../shared/planRunTypes'
import { isRecord } from '../../../shared/guards'

export type ParsedCitationIdentifier =
  | { kind: 'doi'; id: string; raw: string }
  | { kind: 'pmid'; id: string; raw: string }
  | { kind: 'pmcid'; id: string; raw: string }
  | { kind: 'arxiv'; id: string; raw: string }
  | { kind: 'url'; id: string; raw: string }

export interface CitationVerifierOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type CitationVerificationOutcome =
  { ok: true; spec: PlanSpec } | { ok: false; errors: string[] }

const DEFAULT_TIMEOUT_MS = 4_000
const DOI_PATTERN = /(?:^doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,9}\/[^\s;<>"]+)/i
const BIORXIV_DOI_PATTERN =
  /https?:\/\/(?:www\.)?(?:bio|med)rxiv\.org\/content\/(10\.\d{4,9}\/[^\s?#v]+)(?:v\d+)?/i
const BARE_DOI_PATTERN = /^(10\.\d{4,9}\/[^\s;<>"]+)$/i
const PMID_PATTERN = /(?:^pmid:\s*|https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/)(\d{4,10})\/?/i
const PMCID_PATTERN =
  /(?:^pmcid:\s*|https?:\/\/(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc\/articles\/|https?:\/\/pmc\.ncbi\.nlm\.nih\.gov\/articles\/)(PMC\d{4,10})\/?/i
const ARXIV_PATTERN =
  /(?:^arxiv:\s*|https?:\/\/arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5}(?:v\d+)?)/i

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;)\]]+$/, '')
}

export function parseCitationReference(rawInput: string): ParsedCitationIdentifier | null {
  const raw = rawInput.trim()
  if (!raw) return null

  const doiMatch =
    DOI_PATTERN.exec(raw) ?? BIORXIV_DOI_PATTERN.exec(raw) ?? BARE_DOI_PATTERN.exec(raw)
  if (doiMatch) {
    return { kind: 'doi', id: stripTrailingPunctuation(doiMatch[1]), raw }
  }
  const pmidMatch = PMID_PATTERN.exec(raw)
  if (pmidMatch) {
    return { kind: 'pmid', id: pmidMatch[1], raw }
  }
  const pmcidMatch = PMCID_PATTERN.exec(raw)
  if (pmcidMatch) {
    return { kind: 'pmcid', id: pmcidMatch[1].toUpperCase(), raw }
  }
  const arxivMatch = ARXIV_PATTERN.exec(raw)
  if (arxivMatch) {
    return { kind: 'arxiv', id: arxivMatch[1], raw }
  }
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return { kind: 'url', id: parsed.href, raw }
    }
  } catch {
    // Not a URL.
  }
  return null
}

type SingleCheckStatus =
  | { state: 'verified' }
  | { state: 'offline' }
  | { state: 'not_found'; reason: string }
  | { state: 'retracted'; reason: string }

async function fetchJsonWithTimeout(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'http_error'; status: number }
  | { kind: 'network_error' }
> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    })
    if (response.status === 404) return { kind: 'http_error', status: 404 }
    if (!response.ok) return { kind: 'network_error' }
    const body = (await response.json()) as unknown
    return { kind: 'json', status: response.status, body }
  } catch {
    return { kind: 'network_error' }
  } finally {
    clearTimeout(timer)
  }
}

function isCrossrefRetracted(message: Record<string, unknown>): boolean {
  const updates = Array.isArray(message['update-to']) ? message['update-to'] : []
  if (
    updates.some(
      (item) =>
        isRecord(item) &&
        typeof item.type === 'string' &&
        item.type.toLowerCase().includes('retract')
    )
  ) {
    return true
  }
  const titles = Array.isArray(message.title) ? message.title : []
  return titles.some((title) => typeof title === 'string' && /^\s*retracted\s*:/i.test(title))
}

async function verifyDoi(
  doi: string,
  raw: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<SingleCheckStatus> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`
  const res = await fetchJsonWithTimeout(url, fetchImpl, timeoutMs)
  if (res.kind === 'network_error') return { state: 'offline' }
  if (res.kind === 'http_error' && res.status === 404) {
    return {
      state: 'not_found',
      reason: `Citation DOI "${doi}" (${raw}) could not be resolved in Crossref; remove fabricated or misspelled DOIs.`
    }
  }
  if (res.kind === 'json' && isRecord(res.body) && isRecord(res.body.message)) {
    if (isCrossrefRetracted(res.body.message)) {
      return {
        state: 'retracted',
        reason: `Citation DOI "${doi}" (${raw}) is marked as retracted and must not be used as supporting evidence.`
      }
    }
    return { state: 'verified' }
  }
  return { state: 'offline' }
}

function isEuropePmcRetracted(hit: Record<string, unknown>): boolean {
  const pubTypes =
    isRecord(hit.pubTypeList) && Array.isArray(hit.pubTypeList.pubType)
      ? hit.pubTypeList.pubType
      : []
  if (
    pubTypes.some((item) => typeof item === 'string' && item.toLowerCase().includes('retracted'))
  ) {
    return true
  }
  return typeof hit.title === 'string' && /^\s*\[?retracted\]?/i.test(hit.title)
}

async function verifyEuropePmcQuery(
  query: string,
  label: string,
  raw: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<SingleCheckStatus> {
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=1`
  const res = await fetchJsonWithTimeout(url, fetchImpl, timeoutMs)
  if (res.kind === 'network_error' || res.kind === 'http_error') return { state: 'offline' }
  if (!isRecord(res.body)) return { state: 'offline' }
  const hitCount = typeof res.body.hitCount === 'number' ? res.body.hitCount : undefined
  if (hitCount === 0) {
    return {
      state: 'not_found',
      reason: `Citation ${label} (${raw}) was not found in PubMed/Europe PMC; verify the accession.`
    }
  }
  const results =
    isRecord(res.body.resultList) && Array.isArray(res.body.resultList.result)
      ? res.body.resultList.result
      : []
  const first = results[0]
  if (isRecord(first) && isEuropePmcRetracted(first)) {
    return {
      state: 'retracted',
      reason: `Citation ${label} (${raw}) is indexed as a retracted publication and cannot be cited as valid evidence.`
    }
  }
  return { state: 'verified' }
}

async function verifyArxivOrUrl(
  parsed: Extract<ParsedCitationIdentifier, { kind: 'arxiv' | 'url' }>,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<SingleCheckStatus> {
  const targetUrl =
    parsed.kind === 'arxiv'
      ? `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(parsed.id)}`
      : parsed.id
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(targetUrl, { method: 'GET', signal: controller.signal })
    if (response.status === 404 || response.status === 410) {
      return {
        state: 'not_found',
        reason: `Citation "${parsed.raw}" returned HTTP ${response.status} (not found).`
      }
    }
    if (!response.ok) return { state: 'offline' }
    if (parsed.kind === 'arxiv') {
      const xml = await response.text()
      if (!/<entry>[\s\S]*?<title>/i.test(xml)) {
        return {
          state: 'not_found',
          reason: `arXiv identifier "${parsed.id}" (${parsed.raw}) does not exist.`
        }
      }
    }
    return { state: 'verified' }
  } catch {
    return { state: 'offline' }
  } finally {
    clearTimeout(timer)
  }
}

async function verifySingleCitation(
  parsed: ParsedCitationIdentifier,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<SingleCheckStatus> {
  switch (parsed.kind) {
    case 'doi':
      return verifyDoi(parsed.id, parsed.raw, fetchImpl, timeoutMs)
    case 'pmid':
      return verifyEuropePmcQuery(
        `EXT_ID:${parsed.id} AND SRC:MED`,
        `PMID:${parsed.id}`,
        parsed.raw,
        fetchImpl,
        timeoutMs
      )
    case 'pmcid':
      return verifyEuropePmcQuery(`PMCID:${parsed.id}`, parsed.id, parsed.raw, fetchImpl, timeoutMs)
    case 'arxiv':
    case 'url':
      return verifyArxivOrUrl(parsed, fetchImpl, timeoutMs)
  }
}

export async function verifyPlanLiteratureCitations(
  spec: PlanSpec,
  options: CitationVerifierOptions = {}
): Promise<CitationVerificationOutcome> {
  const review = spec.literatureReview
  if (!review || !review.needed) return { ok: true, spec }

  const references = review.references ?? []
  if (references.length === 0) {
    return {
      ok: false,
      errors: [
        'literatureReview.references must contain at least one verifiable citation (DOI, PMID, PMCID, arXiv, or https:// URL) when literatureReview.needed is true.'
      ]
    }
  }

  const formatErrors: string[] = []
  const parsedRefs: ParsedCitationIdentifier[] = []
  references.forEach((raw, index) => {
    const parsed = parseCitationReference(raw)
    if (!parsed) {
      formatErrors.push(
        `literatureReview.references[${index}] ("${raw}") must include a verifiable identifier (DOI:10..., PMID:..., PMCID:PMC..., arXiv:..., or https:// URL).`
      )
      return
    }
    parsedRefs.push(parsed)
  })
  if (formatErrors.length > 0) return { ok: false, errors: formatErrors }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const statuses = await Promise.all(
    parsedRefs.map((parsed) => verifySingleCitation(parsed, fetchImpl, timeoutMs))
  )

  const errors: string[] = []
  let sawOffline = false
  for (const status of statuses) {
    if (status.state === 'not_found' || status.state === 'retracted') {
      errors.push(status.reason)
    } else if (status.state === 'offline') {
      sawOffline = true
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const verificationStatus: LiteratureVerificationStatus = sawOffline
    ? 'unverified_offline'
    : 'verified'
  const updatedReview: PlanLiteratureReviewDecision = {
    ...review,
    verificationStatus
  }
  return {
    ok: true,
    spec: {
      ...spec,
      literatureReview: updatedReview
    }
  }
}
