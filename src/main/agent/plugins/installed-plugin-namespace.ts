import { dirname } from 'node:path'

import { discoverPhiAgents } from '../agents/discovery'
import { validateSkill } from '../content/skill'
import { isPathInsideRoot } from '../local-file-access'
import { listSkills } from '../resources'
import { getBundledAgentsDir } from '../runtime/runtime-adapter'
import { loadedPlugins, type PluginNamespace } from './loader'

export interface InstalledPluginNamespaceOperations {
  loadedPlugins: (options: { agentDir: string; projectDir?: string }) => Array<{
    components: { skills: string[] }
  }>
  listSkills: (cwd: string) => Promise<Array<{ name: string; filePath: string }>>
  isPathInsideRoot: (root: string, target: string) => boolean
  validateSkill: (
    dir: string,
    options: { expectedName: string }
  ) => { skill?: { phi?: { toolPrefix?: string } } }
  discoverPhiAgents: (options: {
    cwd: string
    agentDir: string
    bundledDir: string
    pluginAgentDirs: readonly string[]
  }) => { agents: Array<{ name: string }> }
  getBundledAgentsDir: () => string
}

const defaultOperations: InstalledPluginNamespaceOperations = {
  loadedPlugins,
  listSkills,
  isPathInsideRoot,
  validateSkill,
  discoverPhiAgents,
  getBundledAgentsDir
}

export interface InstalledPluginNamespaceDeps {
  getAgentDir: () => string
  getSessionCwd: () => string
  operations?: InstalledPluginNamespaceOperations
}

export function createInstalledPluginNamespace(deps: InstalledPluginNamespaceDeps): {
  installedPluginNamespace: (projectDir?: string) => Promise<PluginNamespace>
} {
  const operations = deps.operations ?? defaultOperations

  async function installedPluginNamespace(projectDir?: string): Promise<PluginNamespace> {
    const resourceCwd = projectDir ?? deps.getSessionCwd()
    const pluginSkillRoots = operations
      .loadedPlugins({
        agentDir: deps.getAgentDir(),
        ...(projectDir ? { projectDir } : {})
      })
      .flatMap((plugin) => plugin.components.skills)
    const skills = (await operations.listSkills(resourceCwd)).filter(
      (skill) => !pluginSkillRoots.some((root) => operations.isPathInsideRoot(root, skill.filePath))
    )
    const toolPrefixes = skills.flatMap((skill) => {
      try {
        const result = operations.validateSkill(dirname(skill.filePath), {
          expectedName: skill.name
        })
        return result.skill?.phi?.toolPrefix ? [result.skill.phi.toolPrefix] : []
      } catch {
        return []
      }
    })
    const agents = operations.discoverPhiAgents({
      cwd: resourceCwd,
      agentDir: deps.getAgentDir(),
      bundledDir: operations.getBundledAgentsDir(),
      pluginAgentDirs: []
    }).agents
    return {
      agentNames: agents.map((agent) => agent.name),
      skillNames: skills.map((skill) => skill.name),
      toolPrefixes
    }
  }

  return { installedPluginNamespace }
}
