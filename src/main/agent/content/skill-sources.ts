import { lstatSync, readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { isRecord } from '../../../shared/guards'

export interface SkillSource {
  dir: string
  /** Root-relative parent grouping; omitted for an ungrouped skill. */
  category?: string
}

const MAX_SOURCE_DEPTH = 16
const MAX_SOURCE_ENTRIES = 20_000

/** Discover skill roots without interpreting reference/example SKILL.md files as more skills. */
export function discoverSkillSources(root: string): SkillSource[] {
  const base = resolve(root)
  try {
    const stat = lstatSync(base)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`技能源根目录不是普通目录或包含符号链接：${base}`)
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const sources: SkillSource[] = []
  const identities = new Map<string, string>()
  let entryCount = 0
  const walk = (directory: string, depth: number, insideSkill: boolean): void => {
    const suffix = relative(base, directory)
    if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
      throw new Error('技能源目录越过根目录边界')
    }
    if (depth > MAX_SOURCE_DEPTH) throw new Error(`技能源目录深度超过限制（${MAX_SOURCE_DEPTH}）`)
    const entries = readdirSync(directory)
      .sort()
      .map((name) => {
        entryCount += 1
        if (entryCount > MAX_SOURCE_ENTRIES)
          throw new Error(`技能源条目数量超过限制（${MAX_SOURCE_ENTRIES}）`)
        const path = join(directory, name)
        const stat = lstatSync(path)
        if (stat.isSymbolicLink()) throw new Error(`技能源不允许符号链接：${relative(base, path)}`)
        if (!stat.isDirectory() && !stat.isFile())
          throw new Error(`技能源包含非普通文件：${relative(base, path)}`)
        return { name, path, stat }
      })
    let foundSkill = false
    if (!insideSkill) {
      const manifest = entries.find((entry) => entry.name === 'SKILL.md')
      if (manifest) {
        if (!manifest.stat.isFile()) throw new Error(`技能 SKILL.md 不是普通文件：${directory}`)
        const id = basename(directory)
        const previous = identities.get(id)
        if (previous) {
          throw new Error(
            `重复技能 ID '${id}'：${relative(base, previous)} 与 ${relative(base, directory)}`
          )
        }
        identities.set(id, directory)
        const category =
          directory === base ? '' : relative(base, dirname(directory)).split(sep).join('/')
        sources.push({ dir: directory, ...(category ? { category } : {}) })
        foundSkill = true
      }
    }
    for (const entry of entries) {
      // Continue only the filesystem safety walk within an existing skill's resources.
      if (entry.stat.isDirectory()) walk(entry.path, depth + 1, insideSkill || foundSkill)
    }
  }
  walk(base, 0, false)
  return sources
}

/** A declared category takes priority over the repository's physical grouping. */
export function skillSourceCategory(
  frontmatter: unknown,
  pathCategory?: string
): string | undefined {
  if (isRecord(frontmatter) && isRecord(frontmatter.metadata)) {
    const value = frontmatter.metadata.category
    if (typeof value === 'string') {
      const category = value.trim()
      const hasControlCharacter = [...category].some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
      })
      if (category && category.length <= 200 && !hasControlCharacter) return category
    }
  }
  return pathCategory || undefined
}
