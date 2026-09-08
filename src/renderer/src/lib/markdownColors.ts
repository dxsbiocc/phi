export type MarkdownColorToken =
  | { kind: 'text'; text: string }
  | { kind: 'color'; color: string }
  | { kind: 'palette'; colors: string[] }

const HEX_COLOR_SOURCE = String.raw`#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])`
const HEX_COLOR_PATTERN = new RegExp(HEX_COLOR_SOURCE, 'g')
const EXACT_HEX_COLOR_PATTERN = new RegExp(`^${HEX_COLOR_SOURCE}$`)
const LATEX_COLORBOX_BLOCK_PATTERN = /\$\$([\s\S]*?\\colorbox[\s\S]*?)\$\$/g
const LATEX_COLORBOX_COLOR_PATTERN = new RegExp(
  String.raw`\\colorbox\{(${HEX_COLOR_SOURCE})\}`,
  'g'
)

export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim()
  if (!EXACT_HEX_COLOR_PATTERN.test(trimmed)) return null
  return `#${trimmed.slice(1).toUpperCase()}`
}

export function extractLatexColorboxColors(value: string): string[] {
  const colors: string[] = []

  for (const match of value.matchAll(LATEX_COLORBOX_COLOR_PATTERN)) {
    const color = normalizeHexColor(match[1])
    if (color) colors.push(color)
  }

  return colors
}

function tokenizePlainHexColors(value: string): MarkdownColorToken[] {
  const tokens: MarkdownColorToken[] = []
  let lastIndex = 0

  for (const match of value.matchAll(HEX_COLOR_PATTERN)) {
    const raw = match[0]
    const index = match.index ?? 0
    const color = normalizeHexColor(raw)
    if (!color) continue

    if (index > lastIndex) tokens.push({ kind: 'text', text: value.slice(lastIndex, index) })
    tokens.push({ kind: 'color', color })
    lastIndex = index + raw.length
  }

  if (lastIndex < value.length) tokens.push({ kind: 'text', text: value.slice(lastIndex) })
  return tokens.length > 0 ? tokens : [{ kind: 'text', text: value }]
}

export function tokenizeMarkdownColors(value: string): MarkdownColorToken[] {
  const tokens: MarkdownColorToken[] = []
  let lastIndex = 0

  for (const match of value.matchAll(LATEX_COLORBOX_BLOCK_PATTERN)) {
    const raw = match[0]
    const content = match[1]
    const index = match.index ?? 0
    const colors = extractLatexColorboxColors(content)
    if (colors.length === 0) continue

    if (index > lastIndex) tokens.push(...tokenizePlainHexColors(value.slice(lastIndex, index)))
    tokens.push({ kind: 'palette', colors })
    lastIndex = index + raw.length
  }

  if (lastIndex < value.length) tokens.push(...tokenizePlainHexColors(value.slice(lastIndex)))
  return tokens.length > 0 ? tokens : [{ kind: 'text', text: value }]
}
