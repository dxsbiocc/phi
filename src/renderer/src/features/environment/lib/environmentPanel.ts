import type {
  EnvironmentHostDependency,
  EnvironmentHostTool,
  EnvironmentSnapshot,
  EnvironmentToolState,
  ManagedEnvironmentConsumerKind,
  ManagedEnvironmentEntry,
  ManagedEnvironmentSource,
  ManagedEnvironmentState
} from '../../../../../shared/environmentTypes'
import type { EnvironmentBuildEstimate } from '../../../../../shared/environmentBuildTypes'

export type EnvironmentPanelSection =
  | {
      id: 'managed'
      title: '托管环境'
      items: ManagedEnvironmentEntry[]
    }
  | {
      id: 'host-dependencies'
      title: '宿主依赖'
      items: EnvironmentHostDependency[]
    }
  | {
      id: 'host-tools'
      title: '可选的本机工具'
      items: EnvironmentHostTool[]
    }

export type EnvironmentPanelSections = [
  Extract<EnvironmentPanelSection, { id: 'managed' }>,
  Extract<EnvironmentPanelSection, { id: 'host-dependencies' }>,
  Extract<EnvironmentPanelSection, { id: 'host-tools' }>
]

const SOURCE_ORDER: Record<ManagedEnvironmentSource, number> = {
  official: 0,
  plugin: 1,
  project: 2,
  orphaned: 3
}

const STATE_LABELS: Record<ManagedEnvironmentState, string> = {
  absent: '未构建',
  building: '构建中',
  ready: '已就绪',
  failed: '构建失败',
  drifted: '需要修复'
}

const SOURCE_LABELS: Record<ManagedEnvironmentSource, string> = {
  official: 'Phi 官方',
  plugin: '插件',
  project: '当前项目',
  orphaned: '孤立环境'
}

const CONSUMER_KIND_LABELS: Record<ManagedEnvironmentConsumerKind, string> = {
  skill: '技能',
  agent: '智能体',
  plugin: '插件',
  wrapper: '工作流',
  notebook: 'Notebook',
  kernel: 'Kernel'
}

function legacyHostDependencies(snapshot: EnvironmentSnapshot): EnvironmentHostDependency[] {
  return snapshot.tools
    .filter(
      (tool): tool is EnvironmentToolState & { id: EnvironmentHostDependency['id'] } =>
        tool.id === 'docker' || tool.id === 'singularity'
    )
    .map((tool) => ({
      id: tool.id,
      label: tool.label,
      status:
        tool.status === 'ready' ? 'ready' : tool.status === 'invalid' ? 'unavailable' : 'missing',
      path: tool.activePath ?? tool.detectedPath,
      version: tool.detectedVersion,
      detail: tool.detail,
      messages: tool.messages
    }))
}

function legacyHostTools(snapshot: EnvironmentSnapshot): EnvironmentHostTool[] {
  return snapshot.tools
    .filter(
      (tool): tool is EnvironmentToolState & { id: EnvironmentHostTool['id'] } =>
        tool.id === 'nextflow' || tool.id === 'jupyter'
    )
    .map((tool) => ({
      id: tool.id,
      label: tool.label,
      status: tool.status,
      management: 'host-unmanaged',
      selected: tool.id === 'nextflow' && tool.source === 'custom' && tool.status === 'ready',
      path: tool.activePath,
      detectedPath: tool.detectedPath,
      version: tool.detectedVersion,
      detail: tool.detail,
      messages: tool.messages
    }))
}

function sortedManaged(items: readonly ManagedEnvironmentEntry[]): ManagedEnvironmentEntry[] {
  return [...items].sort((left, right) => {
    const sourceDifference = SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source]
    if (sourceDifference !== 0) return sourceDifference
    return (left.label ?? left.ref).localeCompare(right.label ?? right.ref, 'zh-CN')
  })
}

/** Keeps the panel's product-level grouping independent from its MUI rendering. */
export function buildEnvironmentSections(
  managed: readonly ManagedEnvironmentEntry[],
  snapshot: EnvironmentSnapshot | null
): EnvironmentPanelSections {
  const hostDependencies = snapshot
    ? snapshot.hostDependencies?.length
      ? snapshot.hostDependencies
      : legacyHostDependencies(snapshot)
    : []
  const hostTools = snapshot
    ? snapshot.hostTools?.length
      ? snapshot.hostTools
      : legacyHostTools(snapshot)
    : []

  return [
    { id: 'managed', title: '托管环境', items: sortedManaged(managed) },
    { id: 'host-dependencies', title: '宿主依赖', items: [...hostDependencies] },
    { id: 'host-tools', title: '可选的本机工具', items: [...hostTools] }
  ]
}

export function managedEnvironmentStateLabel(state: ManagedEnvironmentState): string {
  return STATE_LABELS[state]
}

export function managedEnvironmentSourceLabel(source: ManagedEnvironmentSource): string {
  return SOURCE_LABELS[source]
}

export function managedEnvironmentConsumerKindLabel(kind: ManagedEnvironmentConsumerKind): string {
  return CONSUMER_KIND_LABELS[kind]
}

export function formatEnvironmentSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unitIndex
  const precision = unitIndex === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

export function formatBuildEstimate(estimate: EnvironmentBuildEstimate | undefined): string {
  if (!estimate) return '下载量暂不可用'
  const packageSummary = `${estimate.packages} 个包（${estimate.cachedPackages} 个已缓存）`
  if (estimate.remainingBytes === undefined) return `下载量暂不可用 · ${packageSummary}`
  if (estimate.remainingBytes === 0) return `无需下载 · ${packageSummary}`
  return `预计下载 ${formatEnvironmentSize(estimate.remainingBytes)} · ${packageSummary}`
}
