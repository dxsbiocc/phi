import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { parseSkillFile } from '../content/skill'

/** The SDK scans child folders; load exact installed versions and the core authoring file directly. */
export function readDirectSkills(files: readonly string[]): Array<{
  name: string
  description: string
  filePath: string
  baseDir: string
  source: string
  hide?: boolean
}> {
  return files.flatMap((filePath) => {
    try {
      const parsed = parseSkillFile(readFileSync(filePath, 'utf8'))
      if (!parsed.ok || parsed.frontmatter.enabled === false) return []
      const { name, description } = parsed.frontmatter
      if (typeof description !== 'string' || !description.trim()) return []
      const hide =
        parsed.frontmatter.hide === true || parsed.frontmatter['disable-model-invocation'] === true
      return [
        {
          name: typeof name === 'string' && name.trim() ? name.trim() : basename(dirname(filePath)),
          description,
          filePath,
          baseDir: dirname(filePath),
          source: 'phi-content',
          ...(hide ? { hide } : {})
        }
      ]
    } catch {
      return []
    }
  })
}
