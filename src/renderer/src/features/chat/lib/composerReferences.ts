import type { ResourceIconRef } from '../../../../../shared/resourceIconTypes'
import {
  createChatResourceMatcher,
  type ChatResourceKind,
  type ChatResourceMention
} from '../../../lib/chatResourceMentions'

export type InlineComposerReference = {
  from: number
  to: number
  text: string
  kind: ChatResourceKind | 'web'
  id?: string
  name: string
  icon?: ResourceIconRef
  available?: boolean
  onOpen?: () => void
  url?: string
}

function codeRanges(text: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = []
  let offset = 0
  let fence: { marker: string; from: number } | undefined
  for (const line of text.split('\n')) {
    const end = offset + line.length
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.marker[0] &&
        marker[1].length >= fence.marker.length &&
        !marker[2].trim()
      ) {
        ranges.push({ from: fence.from, to: end })
        fence = undefined
      }
    } else if (marker) fence = { marker: marker[1], from: offset }
    else if (/^(?: {4}|\t)/u.test(line)) ranges.push({ from: offset, to: end })
    offset = end + 1
  }
  if (fence) ranges.push({ from: fence.from, to: text.length })
  const masked = text.split('')
  for (const range of ranges) {
    for (let index = range.from; index < range.to; index++) {
      if (masked[index] !== '\n') masked[index] = ' '
    }
  }
  for (const match of masked
    .join('')
    .matchAll(/(?<!`)(`+)(?!`)(?:[\s\S]*?(?<!`)\1(?!`)|[\s\S]*$)/gu)) {
    ranges.push({ from: match.index, to: match.index + match[0].length })
  }
  return ranges
}

function httpUrl(value: string): URL | undefined {
  if (!/^https?:\/\/\S+$/iu.test(value)) return undefined
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/** Decorations describe source ranges; recognizing a reference never rewrites the document. */
export function findInlineComposerReferences(
  text: string,
  resources: readonly ChatResourceMention[],
  onOpenWebUrl?: (url: string) => void
): InlineComposerReference[] {
  const matcher = createChatResourceMatcher(resources)
  const protectedRanges = codeRanges(text)
  const references: InlineComposerReference[] = []
  const protectedAt = (from: number, to: number): boolean =>
    protectedRanges.some((range) => range.from < to && range.to > from)
  const occupied = (from: number, to: number): boolean =>
    protectedAt(from, to) || references.some((range) => range.from < to && range.to > from)
  const addLink = (from: number, to: number, address: string, label?: string): void => {
    if (occupied(from, to)) return
    const resource = matcher.resolveHref(address)
    if (resource) {
      references.push({ ...resource, from, to, text: text.slice(from, to) })
      return
    }
    const url = httpUrl(address)
    if (url)
      references.push({
        from,
        to,
        kind: 'web',
        name: label ?? url.hostname,
        url: address,
        text: text.slice(from, to),
        onOpen: onOpenWebUrl ? () => onOpenWebUrl(address) : undefined
      })
  }
  for (const match of text.matchAll(/\[([^\]\n]+)\]\(/gu)) {
    const start = match.index + match[0].length
    let depth = 1
    for (let end = start; end < text.length && text[end] !== '\n'; end++) {
      if (text[end] === '\\') {
        end++
        continue
      }
      if (text[end] === '(') depth++
      if (text[end] === ')' && --depth === 0) {
        addLink(match.index, end + 1, text.slice(start, end), match[1])
        break
      }
    }
  }
  let offset = 0
  for (const token of matcher.tokenize(text)) {
    const end = offset + token.text.length
    if (
      token.kind === 'resource' &&
      /^(?:\$|\/(?:agent|prompts):|调用智能体：|(?:agent|skill|wrapper|plugin|connector|mcp):)/iu.test(
        token.text
      ) &&
      !occupied(offset, end)
    ) {
      references.push({ ...token.resource, from: offset, to: end, text: token.text })
    }
    offset = end
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`，。！？、；]+/giu)) {
    let address = match[0].replace(/[.,;!?]+$/u, '')
    while (
      address.endsWith(')') &&
      (address.match(/\)/g)?.length ?? 0) > (address.match(/\(/g)?.length ?? 0)
    ) {
      address = address.slice(0, -1)
    }
    addLink(match.index, match.index + address.length, address)
  }
  return references.sort((left, right) => left.from - right.from)
}

export function inlineReferenceInsertion(
  source: string,
  from: number,
  to: number,
  reference: string
): {
  from: number
  to: number
  insert: string
  cursor: number
} {
  const before = source.slice(0, from)
  const after = source.slice(to)
  const leading = before && !/\s$/u.test(before) ? ' ' : ''
  const trailing = /^[ \t]/u.test(after) ? '' : ' '
  const insert = `${leading}${reference.trim()}${trailing}`
  return { from, to, insert, cursor: from + insert.length + (!trailing ? 1 : 0) }
}
