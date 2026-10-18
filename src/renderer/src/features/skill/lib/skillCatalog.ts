import { skillCopy } from './skillCopy'
import { resourceUi } from '../../../lib/resourceUi'
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
  get bundled() {
    return resourceUi.builtIn
  },
  get 'installed-package'() {
    return skillCopy.installedSource
  },
  get user() {
    return skillCopy.personalSource
  },
  get project() {
    return skillCopy.projectSource
  },
  get plugin() {
    return resourceUi.plugin
  }
}

export function skillIsEnabled(skill: SkillSummary): boolean {
  return typeof skill.enabled === 'boolean' ? skill.enabled : !skill.disabled
}

export function skillIsGloballyEnabled(skill: SkillSummary): boolean {
  return typeof skill.globalEnabled === 'boolean' ? skill.globalEnabled : skillIsEnabled(skill)
}

export function skillSourceLabel(skill: SkillSummary): string {
  if (skill.sourceCategory === 'bundled') {
    return skill.core ? skillCopy.builtInCore : resourceUi.builtIn
  }
  if (skill.sourceCategory === 'plugin') {
    return skillCopy.pluginSource(skill.sourceId ?? skill.source)
  }
  return skillSourceCategoryLabels[skill.sourceCategory]
}

export function registrySkillPackages(
  registry: Pick<PackageRegistryView, 'packages'> | null | undefined
): PackageRegistryEntryView[] {
  if (!registry) return []
  return registry.packages.filter((entry) => entry.type === 'skill')
}

export function skillDirectory(filePath: string): string {
  const normalizedPath = filePath.replaceAll('\\', '/')
  const separatorIndex = normalizedPath.lastIndexOf('/')
  return separatorIndex > 0 ? filePath.slice(0, separatorIndex) : ''
}
