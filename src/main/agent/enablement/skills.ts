import {
  getEnablementSnapshot,
  isCoreSkill,
  type EnablementResolutionOptions,
  type EnablementSource
} from './state'

export interface EnablementSkillLike {
  name?: string
  filePath: string
  sourceInfo?: {
    source?: string
    scope?: string
    origin?: string
    baseDir?: string
  }
}

export interface SkillToolLike {
  skill: string
}

function normalized(value: string | undefined): string {
  return value ? value.replaceAll('\\', '/').toLowerCase() : ''
}

export function skillEnablementSource(skill: EnablementSkillLike): EnablementSource {
  const filePath = normalized(skill.filePath)
  const source = normalized(skill.sourceInfo?.source)
  const origin = normalized(skill.sourceInfo?.origin)
  const baseDir = normalized(skill.sourceInfo?.baseDir)
  const haystack = `${filePath} ${baseDir} ${source} ${origin}`

  if (source === 'installed-package' || haystack.includes('/packages/skill/')) {
    return 'installed-package'
  }
  if (skill.sourceInfo?.scope === 'project') return 'project'
  if (
    haystack.includes('/resources/skills/') ||
    (source === 'bundled' && origin.includes('resources'))
  ) {
    return 'bundled'
  }
  if (source === 'phi-plugin' || haystack.includes('/packages/plugin/')) return 'plugin'
  return 'user'
}

export function filterEnabledMainSkills<T extends EnablementSkillLike & { name: string }>(
  skills: readonly T[],
  options?: EnablementResolutionOptions
): T[] {
  const snapshot = getEnablementSnapshot(options)
  return skills.filter((skill) => {
    if (isCoreSkill(skill.name)) return true
    const key = `skill:${skill.name}`
    return (
      snapshot.project[key] ?? snapshot.global[key] ?? skillEnablementSource(skill) !== 'bundled'
    )
  })
}

export function filterMainScriptTools<T extends SkillToolLike>(
  tools: readonly T[],
  enabledSkillNames: Iterable<string>
): T[] {
  const enabled = new Set(enabledSkillNames)
  return tools.filter((tool) => enabled.has(tool.skill))
}

export function selectDeclaredSpecialistSkills<T extends { name: string }>(
  skills: readonly T[],
  declaredNames: Iterable<string>
): T[] {
  const declared = new Set(declaredNames)
  return skills.filter((skill) => declared.has(skill.name))
}
