import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import semver from 'semver'

import type { SkillPackageDetailView } from '../../../shared/packageManagerTypes'
import { getPhiAgentDir } from '../runtime-paths'
import type { LocalRegistry } from './installer-types'
import type { OfficialRegistryOptions } from './official-registry'
import { archiveFiles, readPackageArchive } from './package-archive'
import { listActiveSkillPackages } from './store'

const SKILL_FILE = 'SKILL.md'

/**
 * The SKILL.md of a skill package so the catalog can show it before installation. An installed
 * package is read from disk; otherwise only that package's verified archive is fetched.
 */
export async function readSkillPackageDetail(
  registry: LocalRegistry,
  id: string,
  options: OfficialRegistryOptions = {}
): Promise<SkillPackageDetailView> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const entry = registry.packages
    .filter((candidate) => candidate.type === 'skill' && candidate.id === id)
    .sort((left, right) => semver.rcompare(left.version, right.version))[0]
  if (!entry) throw new Error(`注册表中找不到技能软件包 ${id}`)

  const installed = listActiveSkillPackages(agentDir).find(
    (item) => item.id === id && item.version === entry.version
  )
  if (installed) {
    return {
      id,
      version: entry.version,
      source: 'installed',
      skillMd: readIfPresent(join(installed.dir, SKILL_FILE))
    }
  }
  const files = archiveFiles(await readPackageArchive(registry, entry, options))
  return {
    id,
    version: entry.version,
    source: 'registry',
    skillMd: files.read(SKILL_FILE) ?? null
  }
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
