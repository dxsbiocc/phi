import type { PromptAgentSummary } from '../../../shared/promptAgentTypes'
import type { WorkspaceHost } from '../workspace-host/types'
import type { PhiAgentDefinition } from './definition'
import {
  discoverPhiAgents,
  type PhiAgentDiagnostic,
  type PhiAgentDiscoveryOptions
} from './discovery'
import { remoteAgentSupportedToolNames, resolveRemoteAgentTools } from './remote-agent-tools'
import {
  discoverRemoteProjectAgents,
  type RemoteProjectAgentEntry
} from './remote-project-agent-discovery'

export interface RemoteAgentCatalogOptions {
  host: WorkspaceHost
  projectRoot: string
  hostAlias: string
  agentDir: string
  cwd: string
  bundledDir?: string
  pluginAgentDirs?: readonly string[]
  homeDir?: string
}

export interface RemoteAgentCatalogResult {
  agents: PhiAgentDefinition[]
  entries: PromptAgentSummary[]
  diagnostics: PhiAgentDiagnostic[]
}

function remoteSummary(entry: RemoteProjectAgentEntry): PromptAgentSummary {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    source: 'server-project-agent',
    trigger: `调用智能体：${entry.name}`,
    scope: 'remote-project',
    trustState: entry.trustState,
    available: entry.available,
    diagnostics: entry.diagnostics,
    relativePath: entry.relativePath,
    contentHash: entry.contentHash
  }
}

function localSummary(
  definition: PhiAgentDefinition,
  available: boolean,
  diagnostics: string[]
): PromptAgentSummary {
  return {
    id: definition.filePath,
    name: definition.name,
    description: definition.description,
    source: 'phi-agent',
    trigger: `调用智能体：${definition.name}`,
    scope: 'local',
    available,
    ...(diagnostics.length > 0 ? { diagnostics } : {})
  }
}

function updateSummary(
  summaries: PromptAgentSummary[],
  id: string,
  available: boolean,
  diagnostics: string[]
): void {
  const index = summaries.findIndex((entry) => entry.id === id)
  const summary = summaries[index]
  if (!summary) return
  summaries[index] = { ...summary, available, diagnostics }
}

function localDiscoveryOptions(options: RemoteAgentCatalogOptions): PhiAgentDiscoveryOptions {
  return {
    cwd: options.cwd,
    agentDir: options.agentDir,
    scope: 'remote-local',
    ...(options.bundledDir ? { bundledDir: options.bundledDir } : {}),
    ...(options.pluginAgentDirs ? { pluginAgentDirs: options.pluginAgentDirs } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {})
  }
}

function resolveProjectAgents(
  definitions: readonly PhiAgentDefinition[],
  trustedEntries: readonly RemoteProjectAgentEntry[],
  summaries: PromptAgentSummary[],
  claimed: Set<string>
): PhiAgentDefinition[] {
  const runnable: PhiAgentDefinition[] = []
  for (const [index, definition] of definitions.entries()) {
    const entry = trustedEntries[index]
    if (!entry) continue
    if (claimed.has(definition.name)) {
      updateSummary(summaries, entry.id, false, ['同名的更高优先级服务器项目 agent 已生效'])
      continue
    }
    claimed.add(definition.name)
    const resolved = resolveRemoteAgentTools(definition, remoteAgentSupportedToolNames())
    const messages = [
      ...entry.diagnostics,
      ...resolved.diagnostics,
      ...(resolved.unavailableReason ? [resolved.unavailableReason] : [])
    ]
    updateSummary(summaries, entry.id, resolved.available, messages)
    if (resolved.available) runnable.push(resolved.agent)
  }
  return runnable
}

function resolveLocalAgents(
  definitions: readonly PhiAgentDefinition[],
  summaries: PromptAgentSummary[],
  claimed: Set<string>
): PhiAgentDefinition[] {
  const runnable: PhiAgentDefinition[] = []
  for (const definition of definitions) {
    if (claimed.has(definition.name)) continue
    claimed.add(definition.name)
    const resolved = resolveRemoteAgentTools(definition, remoteAgentSupportedToolNames())
    const messages = [
      ...definition.warnings,
      ...resolved.diagnostics,
      ...(resolved.unavailableReason ? [resolved.unavailableReason] : [])
    ]
    summaries.push(localSummary(definition, resolved.available, messages))
    if (resolved.available) runnable.push(resolved.agent)
  }
  return runnable
}

function compareSummaries(left: PromptAgentSummary, right: PromptAgentSummary): number {
  const byName = left.name.localeCompare(right.name)
  if (byName !== 0) return byName
  const leftScope = left.scope === 'remote-project' ? 0 : 1
  const rightScope = right.scope === 'remote-project' ? 0 : 1
  return leftScope - rightScope || left.id.localeCompare(right.id)
}

export async function discoverRemoteAgentCatalog(
  options: RemoteAgentCatalogOptions
): Promise<RemoteAgentCatalogResult> {
  const [project, local] = await Promise.all([
    discoverRemoteProjectAgents(options),
    Promise.resolve(discoverPhiAgents(localDiscoveryOptions(options)))
  ])
  const visibleProjectEntries = project.entries.filter((entry) => entry.invocation !== 'host')
  const visibleProjectAgents = project.agents.filter((agent) => agent.invocation !== 'host')
  const visibleLocalAgents = local.agents.filter((agent) => agent.invocation !== 'host')
  const summaries = visibleProjectEntries.map(remoteSummary)
  const claimed = new Set<string>()
  const trustedEntries = visibleProjectEntries.filter((entry) => entry.trustState === 'trusted')
  const projectAgents = resolveProjectAgents(
    visibleProjectAgents,
    trustedEntries,
    summaries,
    claimed
  )
  const localAgents = resolveLocalAgents(visibleLocalAgents, summaries, claimed)
  return {
    agents: [...projectAgents, ...localAgents],
    entries: summaries.sort(compareSummaries),
    diagnostics: [...project.diagnostics, ...local.diagnostics]
  }
}
