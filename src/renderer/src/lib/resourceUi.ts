import { defineCopy, getUiLanguage } from './i18n'
import {
  resourceActionsZh,
  resourceCatalogZh,
  resourceEnvironmentZh,
  resourceTrustZh,
  resourceUiZh
} from './resourceUi.zh-CN'

/** Shared interface copy; resource data is kept separate from the selected UI language. */
export const resourceUi = defineCopy(
  {
    plugins: 'Plugins',
    plugin: 'Plugin',
    skills: 'Skills',
    skill: 'Skill',
    connectors: 'Connectors',
    connector: 'Connector',
    wrappers: 'Wrappers',
    wrapper: 'Wrapper',
    discover: 'Discover',
    search: 'Search',
    install: 'Install',
    installing: 'Installing…',
    installed: 'Installed',
    update: 'Update',
    updating: 'Updating…',
    uninstall: 'Uninstall',
    enabled: 'Enabled',
    disabled: 'Disabled',
    enable: 'Enable',
    disable: 'Disable',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    loading: 'Loading…',
    cancel: 'Cancel',
    close: 'Close',
    confirm: 'Confirm',
    remove: 'Remove',
    retry: 'Retry',
    save: 'Save',
    name: 'Name',
    source: 'Source',
    version: 'Version',
    status: 'Status',
    description: 'Description',
    details: 'Details',
    tools: 'Tools',
    all: 'All',
    other: 'Other',
    officialWebsite: 'Phi Website',
    unsigned: 'Unsigned',
    officialVerified: 'Official · Verified',
    userImported: 'User import',
    localDirectory: 'Local directory',
    builtIn: 'Built-in'
  },
  resourceUiZh
)

export const resourceCatalogCopy = defineCopy(
  {
    back: 'Back',
    actions: 'Actions',
    pagination: 'Catalog pagination',
    rowsPerPage: 'Rows per page',
    pages: { first: 'First page', previous: 'Previous page', next: 'Next page', last: 'Last page' },
    groups: (title: string) => `${title} groups`,
    viewDetails: (title: string) => `View ${title} details`,
    openResource: (label: string, enabled: boolean) =>
      `Open ${label}, ${enabled ? 'enabled' : 'disabled'}`,
    uninstallResource: (label: string) => `Uninstall ${label}`,
    toggleResource: (label: string, enabled: boolean) =>
      `${enabled ? 'Disable' : 'Enable'} ${label}`,
    removeReference: (kind: string, name: string) => `Remove ${kind} reference ${name}`,
    viewReference: (kind: string, name: string) => `View ${kind} ${name}`,
    closeTab: (title: string) => `Close ${title}`,
    noSkillReferences: 'No Skills available to reference',
    officialRefreshFailed: (detail: string) =>
      `Could not refresh the Phi Website catalog: ${detail}`,
    fallbackSource: 'Falling back to the original Phi Packages source.',
    sourceListFailed: (detail: string) => `Could not load local sources: ${detail}`,
    sourceUnavailable: 'Source is temporarily unavailable',
    cachedSource: (label: string) => `${label}: using the offline cache.`,
    restartBackend:
      'Phi is running an older backend. Quit and restart Phi to load official sources.',
    permissionApproval: 'Installation approval',
    capabilityInstall: 'Install capability',
    openSession: 'Open chat',
    reject: 'Deny',
    approve: 'Approve',
    resourceOverview: 'Resource Overview',
    resourceOverviewScope: 'Enabled / available in the current workspace',
    available: 'Available',
    total: (count: number) => `${count} total`,
    resourceLoading: (label: string) => `Loading ${label}`,
    resourceCounts: (label: string, active: number, activeLabel: string, total: number) =>
      `${label}: ${active} ${activeLabel.toLowerCase()}, ${total} total`,
    wrapperRanking: 'Wrapper Run Ranking',
    savedRuns: (count: number) => `${count} runs saved on this device`,
    noWrapperRuns: 'Run a Wrapper to see its ranking here.'
  },
  resourceCatalogZh
)

export const resourceTrustCopy = defineCopy(
  {
    remoteProject: 'Remote Project',
    pending: 'Not trusted',
    changed: 'Content changed',
    trusted: 'Trusted',
    invalid: 'Invalid',
    unavailable: 'Unavailable',
    degraded: 'Degraded',
    revoke: 'Revoke trust',
    trustAgain: 'Trust again',
    trust: 'Trust',
    builtinDescription: 'Included with the Phi application',
    officialDescription: 'Verified using an official Phi signature',
    importedDescription: 'No official signature; imported from a source you selected'
  },
  resourceTrustZh
)

export const resourceEnvironmentCopy = defineCopy(
  {
    confirmTitle: (name: string) => `Build ${name}?`,
    confirmDescription: 'The build runs in the background. Follow its progress in Background Jobs.',
    working: 'Working…',
    startBuild: 'Start build',
    unknown: 'Unknown',
    unavailableDownload: 'Download size unavailable',
    noDownload: 'No download needed',
    packageSummary: (total: number, cached: number) => `${total} packages (${cached} cached)`,
    downloadEstimate: (size: string) => `Estimated download: ${size}`
  },
  resourceEnvironmentZh
)

export const resourceActionMessages = defineCopy(
  {
    skillDisabled: 'Skill disabled',
    skillEnabled: 'Skill enabled',
    skillDisableFailed: 'Could not disable Skill',
    skillEnableFailed: 'Could not enable Skill',
    skillGlobalEnabled: 'Skill enabled globally',
    skillGlobalDisabled: 'Skill disabled globally',
    noLocalProject: 'No local project is currently available',
    skillFollowGlobal: 'Following global Skill settings',
    skillProjectEnabled: 'Skill enabled for this project',
    skillProjectDisabled: 'Skill disabled for this project',
    skillProjectUpdateFailed: 'Could not update project Skill settings',
    installedAndEnabled: (title: string) => `Installed and enabled “${title}”`,
    skillUninstalled: 'Skill uninstalled',
    skillUninstallFailed: 'Could not uninstall Skill',
    connectorCannotRemove: 'This Connector cannot be removed from Phi',
    connectorRemoved: 'Connector removed'
  },
  resourceActionsZh
)

const categoryLabels: Readonly<Record<string, string>> = {
  生产力: 'Productivity',
  沟通协作: 'Communication & Collaboration',
  设计创作: 'Design & Creativity',
  健康与生命科学: 'Health & Life Sciences',
  科研数据: 'Research Data',
  自建: 'Custom',
  自定义: 'Custom',
  其他: 'Other',
  全部: 'All',
  全部技能: 'All Skills',
  科学技能: 'Scientific Skills',
  科学分析: 'Scientific Analysis',
  元能力: 'Meta Capabilities',
  科研: 'Research',
  生物信息: 'Bioinformatics',
  成像: 'Imaging',
  科学: 'Science',
  元技能: 'Meta Skills',
  基础能力: 'Core Capabilities',
  软件包: 'Packages',
  模块: 'Modules',
  子流程: 'Subworkflows',
  工作流: 'Workflows',
  可视化: 'Visualization',
  数据分析: 'Data Analysis',
  生物信息学: 'Bioinformatics'
}

/** Translate known catalog labels for display; selection and persistence use the original value. */
export function resourceCategoryLabel(value: string): string {
  if (getUiLanguage() === 'zh-CN') {
    return Object.entries(categoryLabels).find(([, english]) => english === value)?.[0] ?? value
  }
  return Object.hasOwn(categoryLabels, value) ? categoryLabels[value] : value
}

const sourceLabels: Readonly<Record<string, string>> = {
  'Phi 官网': 'Phi Website',
  已安装: 'Installed',
  用户软件源: 'User source',
  内置: 'Built-in',
  用户导入: 'User import',
  官方软件源: 'Official source',
  软件源: 'Registry',
  我的技能: 'My Skills',
  项目: 'Project',
  插件: 'Plugin',
  软件包: 'Packages'
}

export function resourceSourceLabel(value: string): string {
  if (getUiLanguage() === 'zh-CN') {
    return Object.entries(sourceLabels).find(([, english]) => english === value)?.[0] ?? value
  }
  return Object.hasOwn(sourceLabels, value) ? sourceLabels[value] : value
}

function labelSearchTerms(value: string, labels: Readonly<Record<string, string>>): string[] {
  const english = Object.hasOwn(labels, value) ? labels[value] : value
  const originals = Object.entries(labels)
    .filter(([, translated]) => translated === english)
    .map(([original]) => original)
  return [...new Set([value, english, ...originals])]
}

/** Search aliases remain stable while the interface language changes. */
export function resourceCategorySearchTerms(value: string): string[] {
  return labelSearchTerms(value, categoryLabels)
}

export function resourceSourceSearchTerms(value: string): string[] {
  return labelSearchTerms(value, sourceLabels)
}
