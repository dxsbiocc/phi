import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { ResourceIconRef } from '../../shared/resourceIconTypes'
import { RESOURCE_ICON_MAX_BYTES } from '../../shared/resourceIconTypes'
import { getBundledResourceDir } from './runtime/runtime-adapter'
import { readResourceIcon, registerResourceIconAsset } from './resource-icons'

export type CuratedIconKind = 'agent' | 'skill'

interface CuratedIconEntry {
  id: string
  name: string
  category: string
  kinds: CuratedIconKind[]
  path: string
  sourceUrl: string
  sha256: string
  size: number
}

interface CuratedIconCatalog {
  schemaVersion: 1
  catalogVersion: string
  sourceUrl: string
  websiteUrl: string
  commercialUse: { statement: string; sourceUrl: string }
  entries: CuratedIconEntry[]
}

interface CachedCatalog {
  revision: string
  catalog: CuratedIconCatalog
  refs: Map<string, ResourceIconRef | null>
}

const catalogCache = new Map<string, CachedCatalog>()
const KINDS = new Set<CuratedIconKind>(['agent', 'skill'])
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SHA256 = /^[a-f0-9]{64}$/
const CATALOG_NAME = 'catalog.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function httpsUrl(value: unknown, hostname?: string): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (!hostname || url.hostname === hostname)
  } catch {
    return false
  }
}

function parseEntry(value: unknown): CuratedIconEntry | undefined {
  if (!isRecord(value)) return undefined
  const { id, name, category, kinds, path, sourceUrl, sha256, size } = value
  if (
    typeof id !== 'string' ||
    !SLUG.test(id) ||
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 200 ||
    typeof category !== 'string' ||
    !SLUG.test(category) ||
    !Array.isArray(kinds) ||
    kinds.length === 0 ||
    kinds.length > 2 ||
    !kinds.every(
      (kind): kind is CuratedIconKind =>
        typeof kind === 'string' && KINDS.has(kind as CuratedIconKind)
    ) ||
    new Set(kinds).size !== kinds.length ||
    typeof path !== 'string' ||
    !/^(?:agent|skill)\/[a-z0-9]+(?:-[a-z0-9]+)*\.webp$/.test(path) ||
    !httpsUrl(sourceUrl, 'cdn.ipaslogo.com') ||
    !new URL(sourceUrl).pathname.startsWith('/display-512/') ||
    !new URL(sourceUrl).pathname.endsWith('.webp') ||
    typeof sha256 !== 'string' ||
    !SHA256.test(sha256) ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > RESOURCE_ICON_MAX_BYTES
  ) {
    return undefined
  }
  return { id, name, category, kinds, path, sourceUrl, sha256, size }
}

function parseCatalog(value: unknown): CuratedIconCatalog | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined
  const { catalogVersion, sourceUrl, websiteUrl, commercialUse, entries } = value
  if (
    typeof catalogVersion !== 'string' ||
    catalogVersion.length === 0 ||
    catalogVersion.length > 128 ||
    !httpsUrl(sourceUrl) ||
    !httpsUrl(websiteUrl) ||
    !isRecord(commercialUse) ||
    typeof commercialUse.statement !== 'string' ||
    commercialUse.statement.length === 0 ||
    commercialUse.statement.length > 500 ||
    !httpsUrl(commercialUse.sourceUrl) ||
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.length > 512
  ) {
    return undefined
  }
  const parsedEntries = entries.map(parseEntry)
  if (parsedEntries.some((entry) => !entry)) return undefined
  const typedEntries = parsedEntries as CuratedIconEntry[]
  if (new Set(typedEntries.map((entry) => entry.id)).size !== typedEntries.length) return undefined
  if (new Set(typedEntries.map((entry) => entry.path)).size !== typedEntries.length)
    return undefined
  if (![...KINDS].every((kind) => typedEntries.some((entry) => entry.kinds.includes(kind)))) {
    return undefined
  }
  return {
    schemaVersion: 1,
    catalogVersion,
    sourceUrl,
    websiteUrl,
    commercialUse: {
      statement: commercialUse.statement,
      sourceUrl: commercialUse.sourceUrl
    },
    entries: typedEntries
  }
}

function catalogRevision(path: string): string {
  const stat = statSync(path)
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

function loadCatalog(root: string): CuratedIconCatalog | undefined {
  try {
    const catalogPath = join(root, CATALOG_NAME)
    const revision = catalogRevision(catalogPath)
    const cached = catalogCache.get(root)
    if (cached?.revision === revision) return cached.catalog
    const catalog = parseCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')))
    if (!catalog) return undefined
    for (const entry of catalog.entries) {
      const ref = registerResourceIconAsset(root, {
        path: entry.path,
        sha256: entry.sha256,
        size: entry.size
      })
      if (!ref || !readResourceIcon(ref.key)) return undefined
    }
    catalogCache.set(root, { revision, catalog, refs: new Map() })
    return catalog
  } catch {
    return undefined
  }
}

function candidateScore(kind: CuratedIconKind, stableId: string, entryId: string): Buffer {
  return createHash('sha256')
    .update('phi-curated-icon-v1\0')
    .update(kind)
    .update('\0')
    .update(stableId)
    .update('\0')
    .update(entryId)
    .digest()
}

function chooseEntry(
  kind: CuratedIconKind,
  stableId: string,
  entries: CuratedIconEntry[]
): CuratedIconEntry | undefined {
  let selected: CuratedIconEntry | undefined
  let selectedScore: Buffer | undefined
  for (const entry of entries) {
    if (!entry.kinds.includes(kind)) continue
    const score = candidateScore(kind, stableId, entry.id)
    if (!selectedScore || Buffer.compare(score, selectedScore) > 0) {
      selected = entry
      selectedScore = score
    }
  }
  return selected
}

/** Resolve an offline bundled fallback without consulting the network. */
export function resolveCuratedResourceIcon(
  kind: CuratedIconKind,
  stableId: string,
  iconsRoot?: string
): ResourceIconRef | undefined {
  try {
    if (!KINDS.has(kind) || typeof stableId !== 'string' || !stableId || stableId.length > 4096) {
      return undefined
    }
    const root = resolve(iconsRoot ?? getBundledResourceDir('icons'))
    const catalog = loadCatalog(root)
    if (!catalog) return undefined
    const cached = catalogCache.get(root)
    if (!cached) return undefined
    const entry = chooseEntry(kind, stableId, catalog.entries)
    if (!entry) return undefined
    if (cached.refs.has(entry.id)) return cached.refs.get(entry.id) ?? undefined
    const ref = registerResourceIconAsset(root, {
      path: entry.path,
      sha256: entry.sha256,
      size: entry.size
    })
    const verified = ref && readResourceIcon(ref.key) ? ref : undefined
    cached.refs.set(entry.id, verified ?? null)
    return verified
  } catch {
    return undefined
  }
}
