import { isValidPackageChangelogDate } from '../../../shared/packageManagerTypes'

export type PackageChangeType = 'new' | 'improved' | 'fixed' | 'breaking'

export interface PackageChangelogChange {
  type: PackageChangeType
  /** One release-note sentence, kept as inline markdown. */
  text: string
}

export interface ParsedPackageChangelog {
  changes: PackageChangelogChange[]
  /** Everything that is not a typed top-level bullet, as block markdown. */
  otherNotes: string
  breaking: boolean
}

const CHANGE_TYPES: Readonly<Record<string, PackageChangeType>> = {
  added: 'new',
  new: 'new',
  feature: 'new',
  features: 'new',
  新增: 'new',
  changed: 'improved',
  improved: 'improved',
  improvement: 'improved',
  improvements: 'improved',
  performance: 'improved',
  改进: 'improved',
  优化: 'improved',
  fixed: 'fixed',
  fix: 'fixed',
  fixes: 'fixed',
  'bug fix': 'fixed',
  'bug fixes': 'fixed',
  修复: 'fixed',
  removed: 'breaking',
  breaking: 'breaking',
  'breaking change': 'breaking',
  'breaking changes': 'breaking',
  deprecated: 'breaking',
  移除: 'breaking',
  不兼容: 'breaking'
}

const ATX_HEADING = /^(#{3,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/
const FENCE = /^[ \t]*(`{3,}|~{3,})/
const TOP_LEVEL_BULLET = /^[-*][ \t]+(.*)$/
const NESTED_LIST_ITEM = /^[ \t]+(?:[-*+]|\d+[.)])[ \t]+/
const TABLE_ROW = /^[ \t]*\|/
const BREAKING_MENTION = /\bbreaking\b|no aliases|不兼容/i

interface ChangelogSection {
  heading: string
  headingLine: string
  lines: string[]
}

function normalizedHeading(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[：:]$/, '')
    .trim()
    .toLowerCase()
}

function changeTypeForHeading(text: string): PackageChangeType | undefined {
  return CHANGE_TYPES[normalizedHeading(text)]
}

/** Keep non-bullet markdown under a mapped heading for the details block. */
function parseMappedSection(
  lines: readonly string[],
  type: PackageChangeType
): { changes: PackageChangelogChange[]; other: string } {
  const changes: PackageChangelogChange[] = []
  const other: string[] = []
  let bullet: { lines: string[] } | null = null
  let fence: string | null = null
  const flushBullet = (): void => {
    if (!bullet) return
    const text = bullet.lines.join(' ').replace(/\s+/g, ' ').trim()
    if (text) changes.push({ type, text })
    bullet = null
  }
  const pushOther = (line: string): void => {
    flushBullet()
    other.push(line)
  }

  for (const line of lines) {
    if (fence) {
      other.push(line)
      const closing = new RegExp(`^[ \\t]*${escapeRegExp(fence[0])}{${fence.length},}[ \\t]*$`)
      if (closing.test(line)) fence = null
      continue
    }

    const fenceStart = FENCE.exec(line)
    if (fenceStart) {
      flushBullet()
      other.push(line)
      fence = fenceStart[1] ?? null
      continue
    }

    const topLevel = TOP_LEVEL_BULLET.exec(line)
    if (topLevel) {
      flushBullet()
      bullet = { lines: [topLevel[1] ?? ''] }
      continue
    }

    // Nested lists, tables and code blocks are not part of a typed change.
    if (NESTED_LIST_ITEM.test(line) || TABLE_ROW.test(line)) {
      pushOther(line)
      continue
    }

    if (!line.trim()) {
      if (bullet) bullet.lines.push('')
      else other.push(line)
      continue
    }

    if (/^[ \t]/.test(line)) {
      if (bullet) bullet.lines.push(line.trim())
      else other.push(line)
      continue
    }

    // A paragraph directly under the heading, or after a bullet, is other notes.
    pushOther(line)
  }
  flushBullet()

  return { changes, other: other.join('\n').trim() }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Turns one Keep-a-Changelog-style version section into typed, chip-sized changes while
 * preserving every other block (intro, tables, unmapped headings, nested lists) as markdown.
 */
export function parsePackageChangelogNotes(notes: string): ParsedPackageChangelog {
  const intro: string[] = []
  const sections: ChangelogSection[] = []
  let current: ChangelogSection | null = null
  let fence: string | null = null

  for (const line of notes.split(/\r?\n/)) {
    if (fence) {
      current?.lines.push(line)
      if (!current) intro.push(line)
      const closing = new RegExp(`^[ \\t]*${escapeRegExp(fence[0])}{${fence.length},}[ \\t]*$`)
      if (closing.test(line)) fence = null
      continue
    }

    const fenceStart = FENCE.exec(line)
    if (fenceStart) {
      current?.lines.push(line)
      if (!current) intro.push(line)
      fence = fenceStart[1] ?? null
      continue
    }

    const heading = ATX_HEADING.exec(line)
    if (heading) {
      current = { heading: heading[2] ?? '', headingLine: line, lines: [] }
      sections.push(current)
      continue
    }

    if (current) current.lines.push(line)
    else intro.push(line)
  }

  const introText = intro.join('\n').trim()
  const otherBlocks: string[] = []
  if (introText) otherBlocks.push(introText)
  const changes: PackageChangelogChange[] = []

  for (const section of sections) {
    const type = changeTypeForHeading(section.heading)
    if (!type) {
      const text = [section.headingLine, ...section.lines].join('\n').trim()
      if (text) otherBlocks.push(text)
      continue
    }
    const parsed = parseMappedSection(section.lines, type)
    changes.push(...parsed.changes)
    if (parsed.other) otherBlocks.push(parsed.other)
  }

  return {
    changes,
    otherNotes: otherBlocks.join('\n\n'),
    breaking:
      changes.some((change) => change.type === 'breaking') || BREAKING_MENTION.test(introText)
  }
}

/** Formats a registry date with the current interface locale, ignoring an invalid date. */
export function formatPackageChangelogDate(
  date: string | undefined,
  locale: string
): string | undefined {
  if (!date || !isValidPackageChangelogDate(date)) return undefined
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString(locale, { timeZone: 'UTC' })
}
