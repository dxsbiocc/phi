export interface HeadMetadata {
  title: string | null
  description: string | null
  siteName: string | null
  icons: string[]
  end: number | null
}

const entities: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™'
}

function decodeEntities(value: string): string {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/giu, (whole, entity: string) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? whole
    const code =
      entity[1].toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : ''
  })
}

function clean(value: string | undefined, limit: number): string | null {
  if (!value) return null
  const text = decodeEntities(value)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return text ? text.slice(0, limit) : null
}

function attributes(tag: string): Map<string, string> {
  const values = new Map<string, string>()
  const pattern = /([^\s=<>/'"]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu
  for (const match of tag.matchAll(pattern)) {
    const key = match[1].toLowerCase()
    if (!values.has(key)) values.set(key, match[2] ?? match[3] ?? match[4] ?? '')
  }
  return values
}

/** A bounded head scanner: quoted tag text, comments and raw-text elements cannot invent metadata. */
export function readHeadMetadata(html: string): HeadMetadata {
  const meta = new Map<string, string>()
  const icons: string[] = []
  let title: string | undefined
  let end: number | null = null
  let offset = 0
  while (offset < html.length) {
    const start = html.indexOf('<', offset)
    if (start < 0) break
    if (html.startsWith('<!--', start)) {
      const close = html.indexOf('-->', start + 4)
      if (close < 0) break
      offset = close + 3
      continue
    }
    let quote = ''
    let close = start + 1
    for (; close < html.length; close++) {
      const char = html[close]
      if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
    }
    if (close === html.length) break
    const tag = html.slice(start + 1, close)
    const name = /^\s*(\/?)\s*([a-z][\w:-]*)/iu.exec(tag)
    offset = close + 1
    if (!name) continue
    const closing = Boolean(name[1])
    const kind = name[2].toLowerCase()
    if ((closing && kind === 'head') || (!closing && kind === 'body')) {
      end = offset
      break
    }
    if (closing) continue
    if (
      ![
        'html',
        'head',
        'base',
        'link',
        'meta',
        'title',
        'script',
        'style',
        'template',
        'noscript',
        'noframes'
      ].includes(kind)
    ) {
      end = offset
      break
    }
    if (['script', 'style', 'title', 'template', 'noscript'].includes(kind)) {
      const ending = new RegExp(`</${kind}\\s*>`, 'giu')
      ending.lastIndex = offset
      const match = ending.exec(html)
      if (!match) break
      if (kind === 'title' && title === undefined) title = html.slice(offset, match.index)
      offset = ending.lastIndex
      continue
    }
    if (kind !== 'meta' && kind !== 'link') continue
    const attrs = attributes(tag.slice(name[0].length))
    if (kind === 'meta') {
      const key = (attrs.get('property') ?? attrs.get('name'))?.toLowerCase()
      const content = attrs.get('content')
      if (key && content && !meta.has(key)) meta.set(key, content)
    } else {
      const rel = attrs.get('rel')?.toLowerCase().split(/\s+/u) ?? []
      const href = attrs.get('href')
      if (href && (rel.includes('icon') || rel.includes('apple-touch-icon')) && icons.length < 3) {
        icons.push(decodeEntities(href))
      }
    }
  }
  return {
    title:
      clean(meta.get('og:title'), 512) ??
      clean(meta.get('twitter:title'), 512) ??
      clean(title, 512),
    description:
      clean(meta.get('og:description'), 1024) ??
      clean(meta.get('twitter:description'), 1024) ??
      clean(meta.get('description'), 1024),
    siteName: clean(meta.get('og:site_name'), 128) ?? clean(meta.get('application-name'), 128),
    icons,
    end
  }
}

function validDimensions(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= 512 && height <= 512
}

/** Only small, recognisable raster formats enter the renderer's data-only image policy. */
export function rasterIconDataUrl(body: Buffer, contentType: string): string | null {
  if (!body.length || body.length > 65_536) return null
  const type = contentType.split(';')[0].trim().toLowerCase()
  let mime: string | null = null
  if (
    body.length >= 24 &&
    body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    body.toString('ascii', 12, 16) === 'IHDR' &&
    validDimensions(body.readUInt32BE(16), body.readUInt32BE(20))
  ) {
    mime = 'image/png'
  } else if (
    body.length >= 10 &&
    /^GIF8[79]a$/u.test(body.toString('ascii', 0, 6)) &&
    validDimensions(body.readUInt16LE(6), body.readUInt16LE(8))
  ) {
    mime = 'image/gif'
  } else if (body.length >= 22 && body.readUInt32LE(0) === 0x00010000) {
    const count = body.readUInt16LE(4)
    if (count > 0 && count <= 16 && body.length >= 6 + count * 16) {
      let valid = true
      for (let index = 0; index < count; index++) {
        const offset = 6 + index * 16
        const size = body.readUInt32LE(offset + 8)
        const start = body.readUInt32LE(offset + 12)
        valid &&=
          validDimensions(body[offset] || 256, body[offset + 1] || 256) &&
          size >= 16 &&
          start >= 6 + count * 16 &&
          start + size <= body.length
        if (valid) {
          const png =
            body[start] === 137 &&
            rasterIconDataUrl(body.subarray(start, start + size), 'image/png')
          const dibSize = body.readUInt32LE(start)
          const dib =
            size >= 40 &&
            [40, 108, 124].includes(dibSize) &&
            body.readInt32LE(start + 4) === (body[offset] || 256) &&
            Math.abs(body.readInt32LE(start + 8)) === (body[offset + 1] || 256) * 2
          valid &&= Boolean(png || dib)
        }
      }
      if (valid) mime = 'image/x-icon'
    }
  }
  const allowed =
    mime === 'image/x-icon'
      ? ['image/x-icon', 'image/vnd.microsoft.icon', 'application/octet-stream']
      : [mime]
  return mime && allowed.includes(type) ? `data:${mime};base64,${body.toString('base64')}` : null
}
