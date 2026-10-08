import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats
} from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  RESOURCE_ICON_MAX_BYTES,
  type RegistryIconAsset,
  type ResourceIconRef
} from '../../shared/resourceIconTypes'

const ICON_NAMES = ['icon.svg', 'icon.png', 'icon.webp', 'icon.jpg', 'icon.jpeg']
const MAX_REGISTRATIONS = 2048
const MAX_CACHED_ICONS = 128
const MAX_CACHE_BYTES = 8 * 1024 * 1024
const registrationSalt = randomBytes(16)

interface Registration {
  root: string
  canonicalRoot: string
  path: string
  expected?: { sha256: string; size: number }
}

interface CachedIcon {
  revision: string
  dataUrl: string | null
  size: number
}

const registrations = new Map<string, Registration>()
const imageCache = new Map<string, CachedIcon>()
let cacheBytes = 0

function touch<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key)
  map.set(key, value)
}

function forgetCachedIcon(key: string): void {
  const previous = imageCache.get(key)
  if (previous) cacheBytes -= previous.size
  imageCache.delete(key)
}

function cacheIcon(key: string, revision: string, dataUrl: string | null): void {
  forgetCachedIcon(key)
  const size = dataUrl?.length ?? 0
  imageCache.set(key, { revision, dataUrl, size })
  cacheBytes += size
  while (imageCache.size > MAX_CACHED_ICONS || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = imageCache.keys().next().value
    if (oldest === undefined) break
    forgetCachedIcon(oldest)
  }
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !isAbsolute(path) &&
    !/[\\\0:]/.test(path) &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  )
}

/** Reject symlinks at the resource root and every child component. */
function safeFile(
  root: string,
  path: string
): { root: string; file: string; stat: Stats } | undefined {
  if (!safeRelativePath(path)) return undefined
  const rootStat = lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined
  const canonicalRoot = realpathSync(root)
  const file = resolve(canonicalRoot, path)
  const child = relative(canonicalRoot, file)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
    return undefined
  let candidate = canonicalRoot
  const components = child.split(sep)
  for (let index = 0; index < components.length; index += 1) {
    candidate = join(candidate, components[index])
    const stat = lstatSync(candidate)
    if (stat.isSymbolicLink()) return undefined
    if (index < components.length - 1) {
      if (!stat.isDirectory()) return undefined
    } else {
      if (!stat.isFile() || stat.size === 0 || stat.size > RESOURCE_ICON_MAX_BYTES) return undefined
      if (realpathSync(candidate) !== file) return undefined
      return { root: canonicalRoot, file, stat }
    }
  }
  return undefined
}

function register(registration: Registration): ResourceIconRef {
  const key = createHash('sha256')
    .update(registrationSalt)
    .update(JSON.stringify(registration))
    .digest('hex')
  touch(registrations, key, registration)
  while (registrations.size > MAX_REGISTRATIONS) {
    const oldest = registrations.keys().next().value
    if (oldest === undefined) break
    registrations.delete(oldest)
    forgetCachedIcon(oldest)
  }
  return { key }
}

/** Register conventional resource-local filenames without reading image bytes. */
export function findResourceIcon(
  directory: string,
  fallbackDirectories: readonly string[] = []
): ResourceIconRef | undefined {
  for (const root of [directory, ...fallbackDirectories.slice(0, 16)]) {
    for (const path of ICON_NAMES) {
      try {
        const candidate = safeFile(root, path)
        if (candidate) return register({ root: resolve(root), canonicalRoot: candidate.root, path })
      } catch {
        // Optional presentation metadata never blocks resource discovery.
      }
    }
  }
  return undefined
}

/** Registry sidecars are only served after lazy size/hash and image validation. */
export function registerResourceIconAsset(
  root: string,
  asset: RegistryIconAsset
): ResourceIconRef | undefined {
  try {
    if (
      !asset ||
      typeof asset.path !== 'string' ||
      !safeRelativePath(asset.path) ||
      !['.svg', '.png', '.webp', '.jpg', '.jpeg'].includes(extname(asset.path).toLowerCase()) ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      asset.size > RESOURCE_ICON_MAX_BYTES
    ) {
      return undefined
    }
    const candidate = safeFile(root, asset.path)
    if (!candidate || candidate.stat.size !== asset.size) return undefined
    return register({
      root: resolve(root),
      canonicalRoot: candidate.root,
      path: asset.path,
      expected: { sha256: asset.sha256, size: asset.size }
    })
  } catch {
    return undefined
  }
}

function revision(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

const SVG_TAGS = new Set([
  'svg',
  'g',
  'defs',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'title',
  'desc',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'symbol',
  'use',
  'text',
  'tspan',
  'style',
  'metadata'
])
const SVG_ATTRIBUTES = new Set([
  'id',
  'xmlns',
  'xmlns:xlink',
  'xmlns:svg',
  'xml:space',
  'class',
  'type',
  'enable-background',
  'version',
  'viewBox',
  'preserveAspectRatio',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'transform',
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'color',
  'clip-path',
  'clip-rule',
  'clipPathUnits',
  'mask',
  'maskUnits',
  'maskContentUnits',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'offset',
  'stop-color',
  'stop-opacity',
  'fx',
  'fy',
  'fr',
  'patternUnits',
  'patternContentUnits',
  'patternTransform',
  'href',
  'xlink:href',
  'style',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'dx',
  'dy',
  'role',
  'aria-label',
  'aria-hidden',
  'focusable',
  'vector-effect',
  'paint-order'
])
const SVG_STYLE_PROPERTIES = new Set([
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'color',
  'clip-path',
  'clip-rule',
  'mask',
  'stop-color',
  'stop-opacity',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'vector-effect',
  'paint-order',
  'enable-background'
])

function safeSvgValue(name: string, value: string): boolean {
  if (/[&<>\\\0]/.test(value)) return false
  if (name === 'xmlns') return value === 'http://www.w3.org/2000/svg'
  if (name === 'xmlns:svg') return value === 'http://www.w3.org/2000/svg'
  if (name === 'xmlns:xlink') return value === 'http://www.w3.org/1999/xlink'
  if (name === 'xml:space') return value === 'preserve' || value === 'default'
  if (name === 'class') return /^[A-Za-z_][\w-]*(?:\s+[A-Za-z_][\w-]*)*$/.test(value)
  if (name === 'type') return value === 'text/css'
  if (name === 'enable-background')
    return /^(?:accumulate|new(?:\s+-?\d+(?:\.\d+)?){4})$/.test(value)
  if (name === 'href' || name === 'xlink:href') return /^#[A-Za-z_][\w.-]*$/.test(value)
  if (name === 'style') {
    return value.split(';').every((declaration) => {
      if (!declaration.trim()) return true
      const separator = declaration.indexOf(':')
      if (separator < 0) return false
      const property = declaration.slice(0, separator).trim()
      return (
        SVG_STYLE_PROPERTIES.has(property) &&
        safeSvgValue(property, declaration.slice(separator + 1).trim())
      )
    })
  }
  if (/[:@/]|(?:javascript|data|expression|var)\s*\(/i.test(value)) return false
  const withoutLocalUrls = value.replace(/url\(\s*#[A-Za-z_][\w.-]*\s*\)/gi, '')
  const safeFunctions = new Set([
    'rgb',
    'rgba',
    'hsl',
    'hsla',
    'matrix',
    'translate',
    'scale',
    'rotate',
    'skewx',
    'skewy'
  ])
  return [...withoutLocalUrls.matchAll(/([A-Za-z_-][\w-]*)\s*\(/g)].every((match) =>
    safeFunctions.has(match[1].toLowerCase())
  )
}

/** Local class selectors and static paint declarations only; CSS escapes and at-rules are rejected. */
function safeSvgCss(source: string): boolean {
  if (/[\\&<>@/]/.test(source)) return false
  let remaining = source.trim()
  while (remaining) {
    const rule = /^(\.[A-Za-z_][\w-]*(?:\s*,\s*\.[A-Za-z_][\w-]*)*)\s*\{([^{}]*)\}/.exec(remaining)
    if (!rule || !safeSvgValue('style', rule[2])) return false
    remaining = remaining.slice(rule[0].length).trim()
  }
  return true
}

/** A deliberately small static SVG vocabulary: no scripts, embedded media, or external references. */
function safeSvg(data: Buffer): boolean {
  let source = data.toString('utf8')
  if (!Buffer.from(source, 'utf8').equals(data) || source.includes('\0')) return false
  source = source.replace(/^\uFEFF/, '').trim()
  source = source.replace(/^<\?xml\s[^?]*\?>\s*/, '')
  source = source.replace(/<!--[\s\S]*?-->/g, '').trim()
  if (source.includes('<!') || source.includes('<?') || !source.startsWith('<svg')) return false
  let stylesValid = true
  source = source.replace(
    /<style(\s[^<>]*?)?>([\s\S]*?)<\/style\s*>/g,
    (_match, attributes, css) => {
      if (!safeSvgCss(css)) stylesValid = false
      return `<style${attributes ?? ''}></style>`
    }
  )
  if (!stylesValid) return false
  const stack: string[] = []
  let offset = 0
  let roots = 0
  const tags = /<(\/?)([A-Za-z][\w:-]*)([^<>]*?)\s*(\/?)>/g
  for (const match of source.matchAll(tags)) {
    const between = source.slice(offset, match.index)
    if (/[<>]/.test(between) || (stack.length === 0 && between.trim())) return false
    if (stack.at(-1) === 'metadata' && between.trim()) return false
    offset = (match.index ?? 0) + match[0].length
    const [, closing, name, attributes, selfClosing] = match
    if (!SVG_TAGS.has(name)) return false
    if (closing) {
      if (attributes.trim() || selfClosing || stack.pop() !== name) return false
      continue
    }
    if (stack.at(-1) === 'metadata') return false
    if (stack.length === 0 && (name !== 'svg' || ++roots !== 1)) return false
    let remaining = attributes
    const seen = new Set<string>()
    while (remaining.trim()) {
      const attribute = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(remaining)
      if (!attribute) return false
      const attrName = attribute[1]
      if (!SVG_ATTRIBUTES.has(attrName) || seen.has(attrName)) return false
      if (!safeSvgValue(attrName, attribute[2] ?? attribute[3])) return false
      seen.add(attrName)
      remaining = remaining.slice(attribute[0].length)
    }
    if (!selfClosing) stack.push(name)
  }
  return roots === 1 && stack.length === 0 && source.slice(offset).trim() === ''
}

function imageMime(data: Buffer, path: string): string | undefined {
  const extension = extname(path).toLowerCase()
  if (extension === '.svg') return safeSvg(data) ? 'image/svg+xml' : undefined
  if (extension === '.png') {
    if (!(
      data.length >= 33 &&
      data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      data.readUInt32BE(8) === 13 &&
      data.toString('ascii', 12, 16) === 'IHDR' &&
      data.readUInt32BE(16) > 0 &&
      data.readUInt32BE(20) > 0 &&
      data.readUInt32BE(16) <= 4096 &&
      data.readUInt32BE(20) <= 4096
    ))
      return undefined
    let offset = 8
    let imageData = false
    while (offset + 12 <= data.length) {
      const size = data.readUInt32BE(offset)
      if (offset + size + 12 > data.length) return undefined
      const chunk = data.toString('ascii', offset + 4, offset + 8)
      if (chunk === 'IDAT') imageData = true
      offset += size + 12
      if (chunk === 'IEND')
        return size === 0 && offset === data.length && imageData ? 'image/png' : undefined
    }
    return undefined
  }
  if (extension === '.webp') {
    if (!(
      data.length >= 20 &&
      data.toString('ascii', 0, 4) === 'RIFF' &&
      data.readUInt32LE(4) === data.length - 8 &&
      data.toString('ascii', 8, 12) === 'WEBP' &&
      data.readUInt32LE(16) <= data.length - 20
    ))
      return undefined
    const chunk = data.toString('ascii', 12, 16)
    const size = data.readUInt32LE(16)
    let width: number
    let height: number
    if (chunk === 'VP8X' && size >= 10) {
      if ((data[20] & 0xc1) !== 0 || data.readUIntLE(21, 3) !== 0) return undefined
      width = data.readUIntLE(24, 3) + 1
      height = data.readUIntLE(27, 3) + 1
    } else if (chunk === 'VP8L' && size >= 5 && data[20] === 0x2f) {
      const dimensions = data.readUInt32LE(21)
      if (dimensions >>> 29) return undefined
      width = (dimensions & 0x3fff) + 1
      height = ((dimensions >>> 14) & 0x3fff) + 1
    } else if (
      chunk === 'VP8 ' &&
      size >= 10 &&
      (data[20] & 1) === 0 &&
      data.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    ) {
      width = data.readUInt16LE(26) & 0x3fff
      height = data.readUInt16LE(28) & 0x3fff
    } else return undefined
    return width > 0 && height > 0 && width <= 4096 && height <= 4096 ? 'image/webp' : undefined
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    if (!(
      data.length >= 4 &&
      data[0] === 0xff &&
      data[1] === 0xd8 &&
      data[data.length - 2] === 0xff &&
      data[data.length - 1] === 0xd9
    ))
      return undefined
    let offset = 2
    let frame = false
    while (offset + 4 <= data.length) {
      if (data[offset] !== 0xff) return undefined
      const marker = data[offset + 1]
      if (marker === 0xda) return frame ? 'image/jpeg' : undefined
      const length = data.readUInt16BE(offset + 2)
      if (length < 2 || offset + length + 2 > data.length) return undefined
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker
        )
      ) {
        if (length < 8) return undefined
        const height = data.readUInt16BE(offset + 5)
        const width = data.readUInt16BE(offset + 7)
        if (height === 0 || width === 0 || height > 4096 || width > 4096) return undefined
        frame = true
      }
      offset += length + 2
    }
    return undefined
  }
  return undefined
}

/** Only registered keys are accepted. Missing, changed, or invalid files yield a generic UI fallback. */
export function readResourceIcon(key: unknown): string | null {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return null
  const registration = registrations.get(key)
  if (!registration) return null
  touch(registrations, key, registration)
  let descriptor: number | undefined
  try {
    const candidate = safeFile(registration.root, registration.path)
    if (!candidate || candidate.root !== registration.canonicalRoot) return null
    descriptor = openSync(candidate.file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(descriptor)
    if (
      !stat.isFile() ||
      stat.size === 0 ||
      stat.size > RESOURCE_ICON_MAX_BYTES ||
      stat.dev !== candidate.stat.dev ||
      stat.ino !== candidate.stat.ino
    )
      return null
    // Recheck parent directories after opening to reject a directory swapped for a symlink.
    const confirmed = safeFile(registration.root, registration.path)
    if (
      !confirmed ||
      confirmed.root !== registration.canonicalRoot ||
      confirmed.stat.dev !== stat.dev ||
      confirmed.stat.ino !== stat.ino
    )
      return null
    const stamp = revision(stat)
    const cached = imageCache.get(key)
    if (cached?.revision === stamp) {
      touch(imageCache, key, cached)
      return cached.dataUrl
    }
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length)
      if (!count) break
      length += count
    }
    const data = buffer.subarray(0, length)
    const expected = registration.expected
    const unchanged = stamp === revision(fstatSync(descriptor)) && length === stat.size
    const matches =
      !expected ||
      (length === expected.size &&
        createHash('sha256').update(data).digest('hex') === expected.sha256)
    const mime = unchanged && matches ? imageMime(data, registration.path) : undefined
    const dataUrl = mime ? `data:${mime};base64,${data.toString('base64')}` : null
    cacheIcon(key, stamp, dataUrl)
    return dataUrl
  } catch {
    forgetCachedIcon(key)
    return null
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        /* The optional image read must not expose filesystem errors. */
      }
    }
  }
}
