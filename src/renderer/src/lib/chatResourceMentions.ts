import type { ResourceIconRef } from '../../../shared/resourceIconTypes'

export type ChatResourceKind = 'skill' | 'wrapper' | 'plugin' | 'mcp'

export type ChatResourceMention = {
  kind: ChatResourceKind
  id: string
  name: string
  icon?: ResourceIconRef
  aliases?: readonly string[]
  onOpen?: () => void
}

export type ChatResourceToken =
  { kind: 'text'; text: string } | { kind: 'resource'; text: string; resource: ChatResourceMention }

type ResourceIndex = Map<string, ChatResourceMention | null>

const REFERENCE_KINDS: Record<string, ChatResourceKind> = {
  skill: 'skill',
  wrapper: 'wrapper',
  plugin: 'plugin',
  connector: 'mcp',
  mcp: 'mcp'
}

// Consume URLs as a whole so their path, query and host cannot produce mentions.
const URL_PATTERN = '(?:[a-z][a-z\\d+.-]*://|www\\.)[^\\s<>"\'`()\\[\\]{},;，。！？、：；]+'
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_-]/u
const HAN_CHARACTER = /\p{Script=Han}/u

function addAlias(index: ResourceIndex, alias: string, resource: ChatResourceMention): void {
  const existing = index.get(alias)
  if (existing === undefined) index.set(alias, resource)
  else if (existing && (existing.kind !== resource.kind || existing.id !== resource.id)) {
    index.set(alias, null)
  }
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function canMentionBare(value: string): boolean {
  return !value.includes('\\') && !/^(?:\/|\.\.?\/|~\/|[a-z]:\/)/iu.test(value)
}

function hasMentionBoundaries(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 2), start).match(/.$/u)?.[0] ?? ''
  const after = end < text.length ? String.fromCodePoint(text.codePointAt(end)!) : ''
  const reference = text
    .slice(start, end)
    .replace(/^(?:\$|(?:skill|wrapper|plugin|connector|mcp):)/iu, '')
  const allowHanNeighbors = /\p{Script=Latin}/u.test(reference) && !HAN_CHARACTER.test(reference)
  if (
    [before, after].some(
      (character) =>
        WORD_CHARACTER.test(character) && !(allowHanNeighbors && HAN_CHARACTER.test(character))
    )
  ) {
    return false
  }
  if (/[./\\@:$]/u.test(before) || /[/\\@]/u.test(after)) return false
  if (text.slice(start - 2, start) === '${') return false
  if (after === '.' && /[\p{L}\p{N}_/\\]/u.test(text[end + 1] ?? '')) return false
  return true
}

export function createChatResourceMatcher(resources: readonly ChatResourceMention[]): {
  tokenize: (text: string) => ChatResourceToken[]
  resolveExact: (text: string) => ChatResourceMention | undefined
  resolveHref: (href: string | undefined) => ChatResourceMention | undefined
} {
  const bare: ResourceIndex = new Map()
  const byKind: Record<ChatResourceKind, ResourceIndex> = {
    skill: new Map(),
    wrapper: new Map(),
    plugin: new Map(),
    mcp: new Map()
  }
  const references = new Set<string>()
  for (const resource of resources) {
    for (const value of [resource.name, resource.id, ...(resource.aliases ?? [])]) {
      const alias = value.trim().toLowerCase()
      if (!alias || /[\r\n]/u.test(alias)) continue
      addAlias(bare, alias, resource)
      addAlias(byKind[resource.kind], alias, resource)
      if (canMentionBare(alias)) references.add(alias)
      for (const [prefix, kind] of Object.entries(REFERENCE_KINDS)) {
        if (kind === resource.kind) references.add(`${prefix}:${alias}`)
      }
      if (resource.kind === 'skill' && canMentionBare(alias)) references.add(`$${alias}`)
    }
  }

  const resolveExact = (text: string): ChatResourceMention | undefined => {
    const reference = text.trim().toLowerCase()
    if (reference.startsWith('$')) {
      const alias = reference.slice(1)
      return canMentionBare(alias) ? (byKind.skill.get(alias) ?? undefined) : undefined
    }
    const explicit = /^(skill|wrapper|plugin|connector|mcp):(.+)$/u.exec(reference)
    if (explicit) return byKind[REFERENCE_KINDS[explicit[1]]].get(explicit[2]) ?? undefined
    return bare.get(reference) ?? undefined
  }

  const resolveHref = (href: string | undefined): ChatResourceMention | undefined => {
    if (!href || href !== href.trim()) return undefined
    const match = /^(skill|wrapper|plugin|connector|mcp):\/\/([^/\\?#]+)\/?$/iu.exec(href)
    if (!match) return undefined
    try {
      const alias = decodeURIComponent(match[2])
      if (alias !== alias.trim() || /[?#\p{Cc}]/u.test(alias)) return undefined
      // Encoded path separators are allowed in ids; only an exact catalog key can resolve.
      return byKind[REFERENCE_KINDS[match[1].toLowerCase()]].get(alias.toLowerCase()) ?? undefined
    } catch {
      return undefined
    }
  }

  const pattern = references.size
    ? new RegExp(
        `${URL_PATTERN}|${[...references]
          .sort((left, right) => right.length - left.length)
          .map(escapePattern)
          .join('|')}`,
        'giu'
      )
    : undefined

  const tokenize = (text: string): ChatResourceToken[] => {
    if (!text) return []
    if (!pattern) return [{ kind: 'text', text }]
    const tokens: ChatResourceToken[] = []
    let plainStart = 0
    pattern.lastIndex = 0
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      let matchedText = match[0]
      let resource = matchedText.includes('://')
        ? resolveHref(matchedText)
        : resolveExact(matchedText)
      // A final sentence period belongs to the surrounding text, not the root URI.
      if (!resource && matchedText.endsWith('.') && matchedText.includes('://')) {
        resource = resolveHref(matchedText.slice(0, -1))
        if (resource) matchedText = matchedText.slice(0, -1)
      }
      const end = match.index + matchedText.length
      if (!resource || !hasMentionBoundaries(text, match.index, end)) continue
      if (match.index > plainStart) {
        tokens.push({ kind: 'text', text: text.slice(plainStart, match.index) })
      }
      tokens.push({ kind: 'resource', text: matchedText, resource })
      plainStart = end
    }
    if (plainStart < text.length) tokens.push({ kind: 'text', text: text.slice(plainStart) })
    return tokens
  }

  return { tokenize, resolveExact, resolveHref }
}
