import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { validateAgentFile, type PhiAgentDefinition, type PhiAgentSource } from './definition'
import { listBundledPlugins } from '../plugins/bundled'
import { PHI_PROJECT_CONFIG_DIR_NAME } from '../runtime-paths'

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
}

function pluginAgentDirectories(options: PhiAgentDiscoveryOptions): string[] {
  if (options.pluginAgentDirs !== undefined) return [...options.pluginAgentDirs]
  return listBundledPlugins().flatMap((plugin) => (plugin.agentsDir ? [plugin.agentsDir] : []))
}

function agentRoots(options: PhiAgentDiscoveryOptions): Root[] {
  const home = options.homeDir ?? homedir()
  const roots: Root[] = [
    { dir: join(options.cwd, PHI_PROJECT_CONFIG_DIR_NAME, 'agents'), source: 'phi' },
    { dir: join(options.agentDir, 'agents'), source: 'phi' },
    ...(options.bundledDir ? [{ dir: options.bundledDir, source: 'phi' as const }] : []),
    ...pluginAgentDirectories(options).map((dir) => ({ dir, source: 'phi' as const }))
  ]
  const compat = [
    ...['.omp', '.pi', '.claude'].map((dir) => join(options.cwd, dir, 'agents')),
    join(home, '.omp', 'agent', 'agents'),
    join(home, '.pi', 'agent', 'agents'),
    join(home, '.claude', 'agents')
  ]
  return [...roots, ...compat.map((dir) => ({ dir, source: 'compat' as const }))]
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
    for (const filePath of markdownFiles(root.dir)) {
      let content: string
      try {
        content = readFileSync(filePath, 'utf-8')
      } catch (error) {
        diagnostics.push({
          filePath,
          level: 'error',
          message: error instanceof Error ? error.message : String(error)
        })
        continue
      }
      const result = validateAgentFile(filePath, content, root.source)
      if (!result.ok || !result.agent) {
        for (const error of result.errors) {
          diagnostics.push({ filePath, level: 'error', message: error.message })
        }
        continue
      }
      // Warnings stay on the agent and in the scan log; they do not skip the file.
      for (const warning of result.warnings) {
        diagnostics.push({ filePath, level: 'warning', message: warning.message })
      }
      if (seen.has(result.agent.name)) continue
      seen.add(result.agent.name)
      agents.push(result.agent)
    }
  }
  return { agents, diagnostics }
}
