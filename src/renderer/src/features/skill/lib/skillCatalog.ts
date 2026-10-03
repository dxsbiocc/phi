import type {
  PackageRegistryEntryView,
  PackageRegistryView
} from '../../../../../shared/packageManagerTypes'
import type { SkillSourceCategory, SkillSummary } from '../../../types'

export const skillSourceCategoryOrder: SkillSourceCategory[] = [
  'bundled',
  'installed-package',
  'user',
  'project',
  'plugin'
]

export const skillSourceCategoryLabels: Record<SkillSourceCategory, string> = {
  bundled: '内置',
  'installed-package': '已安装',
  user: '我的',
  project: '项目',
  plugin: '插件'
}

export function skillIsEnabled(skill: SkillSummary): boolean {
  return typeof skill.enabled === 'boolean' ? skill.enabled : !skill.disabled
}

export function skillIsGloballyEnabled(skill: SkillSummary): boolean {
  return typeof skill.globalEnabled === 'boolean' ? skill.globalEnabled : skillIsEnabled(skill)
}

export function skillSourceLabel(skill: SkillSummary): string {
  if (skill.sourceCategory === 'bundled') {
    return skill.core ? '内置·核心' : '内置'
  }
  if (skill.sourceCategory === 'plugin') {
    return `插件: ${skill.sourceId ?? skill.source}`
  }
  return skillSourceCategoryLabels[skill.sourceCategory]
}

/** Skill contract 1.1.0: deprecated skills stay listed but sort last. */
export function bundledCatalogSkills(skills: SkillSummary[]): SkillSummary[] {
  const available = skills.filter(
    (skill) => skill.sourceCategory === 'bundled' && !skill.core && !skillIsGloballyEnabled(skill)
  )
  return [
    ...available.filter((skill) => !skill.deprecated),
    ...available.filter((skill) => skill.deprecated)
  ]
}

export const DEPRECATED_SKILL_LABEL = '即将替代'

export function registrySkillPackages(
  registry: Pick<PackageRegistryView, 'packages'> | null | undefined
): PackageRegistryEntryView[] {
  if (!registry) return []
  return registry.packages.filter((entry) => entry.type === 'skill')
}

/** A package named like a bundled skill would shadow it; the bundled one is offered instead. */
export function withoutBundledSkillNames<T extends { id: string }>(
  packages: readonly T[],
  skills: readonly SkillSummary[]
): T[] {
  const bundledNames = new Set(
    skills.filter((skill) => skill.sourceCategory === 'bundled').map((skill) => skill.name)
  )
  return packages.filter((entry) => !bundledNames.has(entry.id))
}

export function formatPackageSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`

  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const precision = value >= 10 ? 0 : 1
  return `${value.toFixed(precision).replace(/\.0$/, '')} ${units[unitIndex]}`
}

export function skillDirectory(filePath: string): string {
  const normalizedPath = filePath.replaceAll('\\', '/')
  const separatorIndex = normalizedPath.lastIndexOf('/')
  return separatorIndex > 0 ? filePath.slice(0, separatorIndex) : ''
}
