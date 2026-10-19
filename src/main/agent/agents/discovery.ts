import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { validateAgentFile, type PhiAgentDefinition, type PhiAgentSource } from './definition'
import { loadRemoteWrapperAgent } from './remote-wrapper-agent'
import { loadedPlugins } from '../plugins/loader'
import { PHI_PROJECT_CONFIG_DIR_NAME } from '../runtime-paths'

import { errorMessage } from '../../../shared/errorCodes'

/**
 * Scans for Phi agents. Phi's own directories are authoritative and are read
 * first; foreign layouts are then read for compatibility only, mirroring how
 * Phi skills also honour legacy config directories. First definition of a name
 * wins, so a Phi agent always beats a compat one.
 *
 *   Phi     <cwd>/.phi/agents · <agentDir>/agents (~/.phi/agents) · bundled resources/agents · plugin agents/
 *   compat  <cwd>/{.omp,.pi,.claude}/agents · ~/.omp/agent/agents · ~/.pi/agent/agents · ~/.claude/agents
 */
export interface PhiAgentDiscoveryOptions {
  cwd: string
  agentDir: string
  /** Bundled `resources/agents` (resolved by the caller: it depends on packaging). */
  bundledDir?: string
  /**
   * Plugin `agents/` directories. Scanned after `bundledDir` and before compatibility
   * roots. Omit to scan bundled plugins. Pass `[]` to skip them.
   */
  pluginAgentDirs?: readonly string[]
  homeDir?: string
  /** Remote projects scan only machine-local global, remote Wrapper, and plugin agents. */
  scope?: 'local' | 'remote-local'
}

export interface PhiAgentDiagnostic {
  filePath: string
  message: string
  level: 'error' | 'warning'
}

export interface PhiAgentDiscoveryResult {
  agents: PhiAgentDefinition[]
  diagnostics: PhiAgentDiagnostic[]
}

interface Root {
  dir: string
  source: PhiAgentSource
  pluginId?: string
  remoteWrapper?: boolean
}

function pluginAgentRoots(options: PhiAgentDiscoveryOptions): Root[] {
  if (options.pluginAgentDirs !== undefined) {
    return options.pluginAgentDirs.map((dir) => ({ dir, source: 'phi' as const }))
  }
  const roots = new Map<string, Root>()
  for (const plugin of loadedPlugins({
    agentDir: options.agentDir,
    ...(options.scope !== 'remote-local' && existsSync(options.cwd)
      ? { projectDir: options.cwd }
      : {})
  })) {
    for (const filePath of plugin.components.agents) {
      const dir = dirname(filePath)
      roots.set(`${plugin.id}\0${dir}`, { dir, source: 'phi', pluginId: plugin.id })
    }
  }
  return [...roots.values()]
}

function agentRoots(options: PhiAgentDiscoveryOptions): Root[] {
  const home = options.homeDir ?? homedir()
  if (options.scope === 'remote-local') {
    return [
      { dir: join(options.agentDir, 'agents'), source: 'phi' },
      ...(options.bundledDir
        ? [{ dir: options.bundledDir, source: 'phi' as const, remoteWrapper: true }]
        : []),
      ...pluginAgentRoots(options)
    ]
  }
  const roots: Root[] = [
    { dir: join(options.cwd, PHI_PROJECT_CONFIG_DIR_NAME, 'agents'), source: 'phi' },
    { dir: join(options.agentDir, 'agents'), source: 'phi' },
    ...(options.bundledDir ? [{ dir: options.bundledDir, source: 'phi' as const }] : []),
    ...pluginAgentRoots(options)
  ]
  const compat = [
    ...['.omp', '.pi', '.claude'].map((dir) => join(options.cwd, dir, 'agents')),
    join(home, '.omp', 'agent', 'agents'),
    join(home, '.pi', 'agent', 'agents'),
    join(home, '.claude', 'agents')
  ]
  return [...roots, ...compat.map((dir) => ({ dir, source: 'compat' as const }))]
}

function appendAgent(
  agent: PhiAgentDefinition,
  root: Root,
  agents: PhiAgentDefinition[],
  seen: Set<string>
): void {
  if (seen.has(agent.name)) return
  seen.add(agent.name)
  agents.push(root.pluginId ? { ...agent, pluginId: root.pluginId } : agent)
}

function scanAgentFile(
  filePath: string,
  root: Root,
  agents: PhiAgentDefinition[],
  diagnostics: PhiAgentDiagnostic[],
  seen: Set<string>
): void {
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch (error) {
    diagnostics.push({
      filePath,
      level: 'error',
      message: errorMessage(error)
    })
    return
  }
  const result = validateAgentFile(filePath, content, root.source)
  if (!result.ok || !result.agent) {
    for (const error of result.errors) {
      diagnostics.push({ filePath, level: 'error', message: error.message })
    }
    return
  }
  // Warnings stay on the agent and in the scan log; they do not skip the file.
  for (const warning of result.warnings) {
    diagnostics.push({ filePath, level: 'warning', message: warning.message })
  }
  appendAgent(result.agent, root, agents, seen)
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md'))
      .map((entry) => join(dir, entry.name))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

export function discoverPhiAgents(options: PhiAgentDiscoveryOptions): PhiAgentDiscoveryResult {
  const agents: PhiAgentDefinition[] = []
  const diagnostics: PhiAgentDiagnostic[] = []
  const seen = new Set<string>()

  for (const root of agentRoots(options)) {
    if (root.remoteWrapper) {
      const wrapper = loadRemoteWrapperAgent(root.dir)
      if (wrapper) appendAgent(wrapper, root, agents, seen)
      continue
    }
    for (const filePath of markdownFiles(root.dir)) {
      scanAgentFile(filePath, root, agents, diagnostics, seen)
    }
  }
  return { agents, diagnostics }
}
