export type DatabaseWebPreviewKind = 'string-network' | 'kegg-pathway'

export type DatabaseWebImagePreview = {
  kind: DatabaseWebPreviewKind
  label: string
  sourceUrl: string
  imageUrl: string
  dataUrl: string
  mimeType: 'image/png'
  bytes: number
}

export type DatabaseWebPreviewRequest = Omit<
  DatabaseWebImagePreview,
  'dataUrl' | 'mimeType' | 'bytes'
>

const STRING_HOST_PATTERN =
  /^(?:string-db\.org|version(?:-\d+)*\.string-db\.org|version\d+\.string-db\.org)$/i
const STRING_NETWORK_PAGE_PATTERN = /^\/network\/([^/?#]+)\/?$/
const STRING_API_NETWORK_PATTERN = /^\/api\/(?:image|highres_image|svg)\/network\/?$/

const STRING_NETWORK_PASSTHROUGH_PARAMS = new Set([
  'identifiers',
  'species',
  'required_score',
  'network_flavor',
  'network_type',
  'add_color_nodes',
  'add_white_nodes',
  'show_query_node_labels',
  'hide_node_labels',
  'hide_disconnected_nodes',
  'caller_identity'
])

const KEGG_HOST_PATTERN = /^(?:www\.)?(?:kegg\.jp|genome\.jp)$/i
const KEGG_REST_HOST_PATTERN = /^rest\.kegg\.jp$/i
const KEGG_PATHWAY_ID_PATTERN = /^(?:map|ko|ec|rn|[a-z][a-z0-9]{2,3})\d{5}$/i

function isStringHost(hostname: string): boolean {
  return STRING_HOST_PATTERN.test(hostname)
}

function isKeggHost(hostname: string): boolean {
  return KEGG_HOST_PATTERN.test(hostname) || KEGG_REST_HOST_PATTERN.test(hostname)
}

function parseHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function apiImageUrlFor(baseUrl: URL = new URL('https://string-db.org')): URL {
  return new URL('/api/image/network', `${baseUrl.protocol}//${baseUrl.hostname}`)
}

function speciesFromIdentifier(identifier: string): string | null {
  return identifier.match(/^(\d+)\./)?.[1] ?? null
}

function ensureDefaultNetworkParams(url: URL): void {
  if (!url.searchParams.has('network_flavor')) url.searchParams.set('network_flavor', 'evidence')
  if (!url.searchParams.has('caller_identity')) url.searchParams.set('caller_identity', 'Phi')
}

function ensureSingleProteinNeighborhood(url: URL): void {
  const identifiers = url.searchParams.get('identifiers')
  if (!identifiers || /[\r\n,]/.test(identifiers)) return
  if (!url.searchParams.has('add_white_nodes')) url.searchParams.set('add_white_nodes', '10')
}

function stringApiImageUrlFromNetworkPage(url: URL): string | null {
  const match = url.pathname.match(STRING_NETWORK_PAGE_PATTERN)
  const identifier = match ? decodeURIComponent(match[1]).trim() : ''
  if (!identifier) return null

  const imageUrl = apiImageUrlFor(url)
  imageUrl.searchParams.set('identifiers', identifier)
  const species = speciesFromIdentifier(identifier)
  if (species) imageUrl.searchParams.set('species', species)
  ensureDefaultNetworkParams(imageUrl)
  ensureSingleProteinNeighborhood(imageUrl)
  return imageUrl.toString()
}

function stringApiImageUrlFromCgiNetwork(url: URL): string | null {
  if (url.pathname !== '/cgi/network') return null

  const imageUrl = apiImageUrlFor(url)
  for (const [key, value] of url.searchParams.entries()) {
    if (STRING_NETWORK_PASSTHROUGH_PARAMS.has(key)) imageUrl.searchParams.set(key, value)
  }
  const identifiers = imageUrl.searchParams.get('identifiers') ?? url.searchParams.get('identifier')
  if (!identifiers) return null
  imageUrl.searchParams.set('identifiers', identifiers)

  const species = imageUrl.searchParams.get('species') ?? speciesFromIdentifier(identifiers)
  if (species) imageUrl.searchParams.set('species', species)
  ensureDefaultNetworkParams(imageUrl)
  ensureSingleProteinNeighborhood(imageUrl)
  return imageUrl.toString()
}

function stringApiImageUrlFromApiNetwork(url: URL): string | null {
  if (!STRING_API_NETWORK_PATTERN.test(url.pathname)) return null

  const imageUrl = apiImageUrlFor(url)
  for (const [key, value] of url.searchParams.entries()) {
    if (STRING_NETWORK_PASSTHROUGH_PARAMS.has(key)) imageUrl.searchParams.set(key, value)
  }
  if (!imageUrl.searchParams.has('identifiers')) return null
  ensureDefaultNetworkParams(imageUrl)
  ensureSingleProteinNeighborhood(imageUrl)
  return imageUrl.toString()
}

function stringNetworkImageUrlFromUrl(url: URL): string | null {
  if (!isStringHost(url.hostname)) return null

  return (
    stringApiImageUrlFromNetworkPage(url) ??
    stringApiImageUrlFromCgiNetwork(url) ??
    stringApiImageUrlFromApiNetwork(url)
  )
}

function normalizeKeggPathwayId(value: string | null | undefined): string | null {
  if (!value) return null
  const decoded = decodeURIComponent(value).trim()
  const stripped = decoded.replace(/^(?:path:|pathway:)/i, '')
  return KEGG_PATHWAY_ID_PATTERN.test(stripped) ? stripped : null
}

function keggPathwayIdFromLooseQuery(search: string): string | null {
  const decoded = decodeURIComponent(search.replace(/^\?/, '')).trim()
  const match = decoded.match(
    /(?:^|[=&\s])(?:path:|pathway:)?((?:map|ko|ec|rn|[a-z][a-z0-9]{2,3})\d{5})(?:$|[&\s])/i
  )
  return normalizeKeggPathwayId(match?.[1])
}

function keggPathwayIdFromUrl(url: URL): string | null {
  const restMatch = url.pathname.match(/^\/get\/([^/?#]+)\/image\/?$/)
  if (restMatch && KEGG_REST_HOST_PATTERN.test(url.hostname)) {
    return normalizeKeggPathwayId(restMatch[1])
  }

  const pathwayMatch = url.pathname.match(/^\/pathway\/([^/?#]+)\/?$/)
  if (pathwayMatch) return normalizeKeggPathwayId(pathwayMatch[1])

  const entryMatch = url.pathname.match(/^\/entry\/([^/?#]+)\/?$/)
  if (entryMatch) return normalizeKeggPathwayId(entryMatch[1])

  const imageMatch = url.pathname.match(/^\/kegg\/pathway\/[^/]+\/([^/?#]+)\.png$/)
  if (imageMatch) return normalizeKeggPathwayId(imageMatch[1])

  if (url.pathname === '/kegg-bin/show_pathway') {
    return (
      normalizeKeggPathwayId(url.searchParams.get('map')) ??
      normalizeKeggPathwayId(url.searchParams.get('pathway')) ??
      keggPathwayIdFromLooseQuery(url.search)
    )
  }

  if (url.pathname === '/dbget-bin/www_bget') {
    return keggPathwayIdFromLooseQuery(url.search)
  }

  return null
}

function keggPathwayImageUrlFromUrl(url: URL): string | null {
  if (!isKeggHost(url.hostname)) return null
  const pathwayId = keggPathwayIdFromUrl(url)
  return pathwayId ? `https://rest.kegg.jp/get/${encodeURIComponent(pathwayId)}/image` : null
}

export function databaseWebPreviewRequestFromString(
  value: string
): DatabaseWebPreviewRequest | null {
  const url = parseHttpsUrl(value)
  if (!url) return null

  const stringImageUrl = stringNetworkImageUrlFromUrl(url)
  if (stringImageUrl) {
    return {
      kind: 'string-network',
      label: 'STRING 网络',
      sourceUrl: value,
      imageUrl: stringImageUrl
    }
  }

  const keggImageUrl = keggPathwayImageUrlFromUrl(url)
  if (keggImageUrl) {
    return {
      kind: 'kegg-pathway',
      label: 'KEGG 通路图',
      sourceUrl: value,
      imageUrl: keggImageUrl
    }
  }

  return null
}

export function databaseWebPreviewKindFromString(
  value: string | undefined
): DatabaseWebPreviewKind | null {
  return typeof value === 'string'
    ? (databaseWebPreviewRequestFromString(value)?.kind ?? null)
    : null
}

export function isDatabaseWebPreviewUrl(value: string | undefined): boolean {
  return databaseWebPreviewKindFromString(value) !== null
}
