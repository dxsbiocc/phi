import type { JsonObject, JsonValue } from '../../../../../shared/notebookDocument'

const displayMimePriority = [
  'application/vnd.vegalite+json',
  'application/vnd.vega-lite+json',
  'application/vnd.vega+json',
  'application/vnd.vegalite.v6+json',
  'application/vnd.vega-lite.v6+json',
  'application/vnd.vega.v6+json',
  'application/vnd.vegalite.v5+json',
  'application/vnd.vega-lite.v5+json',
  'application/vnd.vega.v5+json',
  'application/vnd.vegalite.v4+json',
  'application/vnd.vega-lite.v4+json',
  'application/vnd.vega.v4+json',
  'application/vnd.plotly.v1+json',
  'text/html',
  'application/javascript',
  'text/javascript',
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'application/pdf',
  'text/markdown',
  'text/latex',
  'text/csv',
  'application/json',
  'text/plain',
  'video/mp4',
  'video/mpeg'
]

const imageFallbackMimes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/avif',
  'image/bmp',
  'image/tiff'
])
const metadataMime = '__metadata__'
const mimePrecedence = new Map(displayMimePriority.map((mime, index) => [mime, index]))

export type NotebookMimeEntry<T = JsonValue> = [string, T]

export type ProcessedNotebookMimeBundle<T = JsonValue> = {
  entries: NotebookMimeEntry<T>[]
  hidden: string[]
}

export type NotebookMimeMetadata = {
  width?: number
  height?: number
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isVegaMime(mime: string): boolean {
  return /^application\/vnd\.vega(?:-?lite)?(?:\.v\d+)?\+json$/i.test(mime)
}

export function vegaMode(mime: string): 'vega' | 'vega-lite' {
  const normalizedMime = mime.toLowerCase()
  return normalizedMime.includes('vegalite') || normalizedMime.includes('vega-lite')
    ? 'vega-lite'
    : 'vega'
}

export type ExtractedVegaSpec = {
  mime: string
  spec: JsonObject
}

export function isPlotlyMime(mime: string): boolean {
  return mime === 'application/vnd.plotly.v1+json'
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

export function isVideoMime(mime: string): boolean {
  return mime === 'video/mp4' || mime === 'video/mpeg'
}

export function isJavaScriptMime(mime: string): boolean {
  return mime === 'application/javascript' || mime === 'text/javascript'
}

export function textFromValue(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : '')).join('')
  }
  return undefined
}

export function prettyJson(value: JsonValue): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

export function normalizeLatexDelimiters(latex: string): string {
  // Our shared markdown renderer requires $$...$$ (not single $) for math --
  // see MarkdownContent's singleDollarTextMath:false, which exists because a
  // lone $ collides with plain currency text elsewhere in the app. Kernel
  // `text/latex` output has no such ambiguity (the mimetype already tells us
  // it's LaTeX), so normalize whatever delimiter convention it used --
  // MathJax-style \(...\)/\[...\], a single-dollar wrap (e.g. sympy's
  // `$\displaystyle ...$`), or none at all -- to $$...$$.
  const trimmed = latex.trim()
  if (!trimmed) return trimmed

  if (/\\\[|\\\(/.test(trimmed) && !trimmed.includes('$')) {
    return trimmed
      .replace(/\\\[([\s\S]*?)\\\]/g, (_match, inner: string) => `$$${inner}$$`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_match, inner: string) => `$$${inner}$$`)
  }

  if (trimmed.startsWith('$$') && trimmed.endsWith('$$')) return trimmed

  const singleDollarMatch = trimmed.match(/^\$([^$]+)\$$/)
  if (singleDollarMatch) return `$$${singleDollarMatch[1]}$$`

  return trimmed.includes('$') ? trimmed : `$$${trimmed}$$`
}

function finitePositiveNumber(value: JsonValue | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

function collectSizeMetadata(value: JsonValue | undefined): NotebookMimeMetadata {
  if (!isJsonObject(value)) return {}
  return {
    width: finitePositiveNumber(value.width),
    height: finitePositiveNumber(value.height)
  }
}

export function metadataForMime({
  data,
  metadata,
  mime
}: {
  data: JsonObject
  metadata: JsonObject
  mime: string
}): NotebookMimeMetadata {
  const inlineMetadata = isJsonObject(data[metadataMime]) ? data[metadataMime] : {}
  return {
    ...collectSizeMetadata(inlineMetadata[mime]),
    ...collectSizeMetadata(metadata),
    ...collectSizeMetadata(metadata[mime])
  }
}

function parseBalancedJsonObject(source: string, objectStart: number): JsonObject | null {
  if (source[objectStart] !== '{') return null

  let depth = 0
  let quote: '"' | "'" | null = null
  let isEscaped = false

  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (isEscaped) {
        isEscaped = false
      } else if (char === '\\') {
        isEscaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char !== '}') continue

    depth -= 1
    if (depth !== 0) continue

    try {
      const parsed = JSON.parse(source.slice(objectStart, index + 1)) as JsonValue
      return isJsonObject(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  return null
}

function schemaMime(spec: JsonObject): string | null {
  const schema = typeof spec.$schema === 'string' ? spec.$schema.toLowerCase() : ''
  if (schema.includes('vega-lite')) return 'application/vnd.vegalite+json'
  if (schema.includes('vega')) return 'application/vnd.vega+json'
  if (spec.mark !== undefined || spec.encoding !== undefined) return 'application/vnd.vegalite+json'
  if (spec.marks !== undefined || spec.signals !== undefined) return 'application/vnd.vega+json'
  return null
}

function specFromScriptTag(html: string): ExtractedVegaSpec | null {
  const scriptPattern = /<script\b[^>]*type=["']([^"']+)["'][^>]*>([\s\S]*?)<\/script>/gi
  for (const match of html.matchAll(scriptPattern)) {
    const type = match[1]?.toLowerCase()
    if (!type || (!isVegaMime(type) && type !== 'application/json')) continue
    try {
      const parsed = JSON.parse(match[2]?.trim() ?? '') as JsonValue
      if (!isJsonObject(parsed)) continue
      const mime = isVegaMime(type) ? type : schemaMime(parsed)
      if (mime) return { mime, spec: parsed }
    } catch {
      // Keep scanning; Altair HTML often stores the spec in ordinary JavaScript instead.
    }
  }
  return null
}

function specFromJavaScriptAssignment(html: string): ExtractedVegaSpec | null {
  const assignmentPattern = /\b(?:const|let|var)\s+\w*spec\w*\s*=\s*\{/gi
  for (const match of html.matchAll(assignmentPattern)) {
    const objectStart = match.index + match[0].lastIndexOf('{')
    const spec = parseBalancedJsonObject(html, objectStart)
    if (!spec) continue
    const mime = schemaMime(spec)
    if (mime) return { mime, spec }
  }
  return null
}

function specFromVegaEmbedCall(html: string): ExtractedVegaSpec | null {
  const embedPattern = /\bvegaEmbed\s*\(/gi
  for (const match of html.matchAll(embedPattern)) {
    const objectStart = html.indexOf('{', match.index)
    if (objectStart < 0) continue
    const spec = parseBalancedJsonObject(html, objectStart)
    if (!spec) continue
    const mime = schemaMime(spec)
    if (mime) return { mime, spec }
  }
  return null
}

export function extractVegaSpecFromHtml(html: string): ExtractedVegaSpec | null {
  if (!/vega(?:-lite|Embed)|application\/vnd\.vega/i.test(html)) return null
  return (
    specFromScriptTag(html) ?? specFromJavaScriptAssignment(html) ?? specFromVegaEmbedCall(html)
  )
}

function shouldHideImageFallbacks(mime: string): boolean {
  return mime === 'text/html' || isVegaMime(mime) || isPlotlyMime(mime)
}

function priorityForMime(mime: string): number {
  if (mimePrecedence.has(mime)) return mimePrecedence.get(mime) ?? displayMimePriority.length
  if (isVegaMime(mime)) return mimePrecedence.get('application/vnd.vegalite+json') ?? 0
  return displayMimePriority.length
}

export function processNotebookMimeBundle<T = JsonValue>(
  entries: NotebookMimeEntry<T>[]
): ProcessedNotebookMimeBundle<T> {
  const cleanEntries = entries.filter(
    ([mime, value]) => mime !== metadataMime && value !== undefined
  )
  if (cleanEntries.length === 0) {
    return { entries: [], hidden: [] }
  }

  const mimeTypes = new Set(cleanEntries.map(([mime]) => mime))
  const hidden = new Set<string>()

  for (const mime of mimeTypes) {
    if (!shouldHideImageFallbacks(mime)) continue
    for (const fallback of imageFallbackMimes) {
      if (mimeTypes.has(fallback)) hidden.add(fallback)
    }
  }

  if (cleanEntries.some(([mime]) => mime !== 'text/plain')) {
    hidden.add('text/plain')
  }

  const indexedEntries = cleanEntries
    .map(([mime, value], index) => ({ mime, value, index }))
    .filter(({ mime }) => !hidden.has(mime))
    .sort((left, right) => {
      const priorityDelta = priorityForMime(left.mime) - priorityForMime(right.mime)
      return priorityDelta === 0 ? left.index - right.index : priorityDelta
    })

  return {
    entries: indexedEntries.map(({ mime, value }) => [mime, value]),
    hidden: Array.from(hidden).filter((mime) => mimeTypes.has(mime))
  }
}

export function firstDisplayMime(data: JsonObject): string | undefined {
  return displayMimes(data)[0]
}

export function displayMimes(data: JsonObject): string[] {
  return processNotebookMimeBundle(Object.entries(data) as NotebookMimeEntry[]).entries.map(
    ([mime]) => mime
  )
}

export function hasHtmlTable(html: string): boolean {
  return /<table[\s>]/i.test(html)
}
