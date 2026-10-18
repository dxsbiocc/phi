import { environmentUi } from './environmentUi'
import { getUiLocale } from '../../../lib/i18n'
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
export { formatBuildEstimate, formatEnvironmentSize } from '../../../lib/environmentFormatting'

export type EnvironmentPanelSection = {
  id: 'managed'
  title: string
  items: ManagedEnvironmentEntry[]
}

export type EnvironmentPanelSections = [Extract<EnvironmentPanelSection, { id: 'managed' }>]

export type ManagedEnvironmentHostResources = {
  dependencies: EnvironmentHostDependency[]
  tools: EnvironmentHostTool[]
}

const SOURCE_ORDER: Record<ManagedEnvironmentSource, number> = {
  official: 0,
  plugin: 1,
  project: 2,
  orphaned: 3
}

const STATE_LABELS: Record<ManagedEnvironmentState, string> = {
  get absent() {
    return environmentUi.notBuilt
  },
  get building() {
    return environmentUi.building2
  },
  get ready() {
    return environmentUi.ready
  },
  get failed() {
    return environmentUi.buildFailed
  },
  get drifted() {
    return environmentUi.repairNeeded
  }
}

const SOURCE_LABELS: Record<ManagedEnvironmentSource, string> = {
  get official() {
    return environmentUi.phiOfficial
  },
  get plugin() {
    return environmentUi.plugin
  },
  get project() {
    return environmentUi.currentProject
  },
  get orphaned() {
    return environmentUi.orphanedEnvironment
  }
}

const CONSUMER_KIND_LABELS: Record<ManagedEnvironmentConsumerKind, string> = {
  get skill() {
    return environmentUi.skill
  },
  get agent() {
    return environmentUi.agent
  },
  get plugin() {
    return environmentUi.plugin
  },
  get wrapper() {
    return environmentUi.workflow
  },
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

export function environmentHostResources(
  snapshot: EnvironmentSnapshot | null
): ManagedEnvironmentHostResources {
  if (!snapshot) return { dependencies: [], tools: [] }
  return {
    dependencies: snapshot.hostDependencies?.length
      ? [...snapshot.hostDependencies]
      : legacyHostDependencies(snapshot),
    tools: snapshot.hostTools?.length ? [...snapshot.hostTools] : legacyHostTools(snapshot)
  }
}

export function managedEnvironmentHostResources(
  environment: ManagedEnvironmentEntry,
  snapshot: EnvironmentSnapshot | null
): ManagedEnvironmentHostResources {
  const resources = environmentHostResources(snapshot)
  if (environment.ref.startsWith('phi:jupyter@')) {
    return {
      dependencies: [],
      tools: resources.tools.filter((tool) => tool.id === 'jupyter')
    }
  }
  if (environment.ref.startsWith('phi:nextflow@')) {
    return {
      dependencies: resources.dependencies.filter(
        (dependency) => dependency.id === 'docker' || dependency.id === 'singularity'
      ),
      tools: resources.tools.filter((tool) => tool.id === 'nextflow')
    }
  }
  return { dependencies: [], tools: [] }
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
    return (left.label ?? left.ref).localeCompare(right.label ?? right.ref, getUiLocale())
  })
}

/** Keeps the panel's product-level grouping independent from its MUI rendering. */
export function buildEnvironmentSections(
  managed: readonly ManagedEnvironmentEntry[]
): EnvironmentPanelSections {
  return [{ id: 'managed', title: environmentUi.environments, items: sortedManaged(managed) }]
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
