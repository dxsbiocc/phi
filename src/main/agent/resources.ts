import { existsSync, readFileSync } from 'node:fs'
import { WORKSPACE_DIR } from './sessions'
import {
  createRuntimeResourceLoader,
  createRuntimeSettingsManager,
  type RuntimeResourceLoader
} from './runtime-adapter'
import { getGlobalMcpConfigPaths, getPhiAgentDir, getProjectMcpConfigPaths } from './runtime-paths'

const AGENT_DIR = getPhiAgentDir()

export interface SkillSummary {
  id: string
  name: string
  description: string
  filePath: string
  source: string
  scope: 'user' | 'project' | 'temporary'
  disabled: boolean
}

export interface McpServerSummary {
  id: string
  name: string
  command?: string
  args?: string[]
  envKeys?: string[]
  sourcePath?: string
  status: 'configured'
}

type UnknownRecord = Record<string, unknown>

function createResourceLoader(cwd = WORKSPACE_DIR): RuntimeResourceLoader {
  const settingsManager = createRuntimeSettingsManager(cwd, AGENT_DIR, { projectTrusted: true })
  return createRuntimeResourceLoader({
    cwd,
    agentDir: AGENT_DIR,
    settingsManager
  })
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined

  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return undefined
  }
}

function getServerMap(config: unknown): UnknownRecord | undefined {
  if (!isRecord(config)) return undefined
  if (isRecord(config.mcpServers)) return config.mcpServers
  if (isRecord(config.mcp_servers)) return config.mcp_servers

  const looksLikeServerMap = Object.values(config).some(
    (value) => isRecord(value) && typeof value.command === 'string'
  )
  return looksLikeServerMap ? config : undefined
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value.filter((item): item is string => typeof item === 'string')
  return values.length > 0 ? values : undefined
}

function toMcpServerSummary(
  name: string,
  value: unknown,
  sourcePath: string
): McpServerSummary | null {
  if (!isRecord(value)) return null

  const command = typeof value.command === 'string' ? value.command : undefined
  const args = toStringArray(value.args)
  const envKeys = isRecord(value.env) ? Object.keys(value.env).sort() : undefined

  if (!command && !args && !envKeys) return null

  return {
    id: `${sourcePath}:${name}`,
    name,
    command,
    args,
    envKeys,
    sourcePath,
    status: 'configured'
  }
}

export async function listSkills(cwd = WORKSPACE_DIR): Promise<SkillSummary[]> {
  const loader = createResourceLoader(cwd)
  await loader.reload()
  const { skills } = loader.getSkills()

  return skills
    .map((skill) => ({
      id: skill.filePath,
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      source: skill.sourceInfo.source,
      scope: skill.sourceInfo.scope,
      disabled: Boolean(skill.disableModelInvocation)
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export async function listMcpServers(cwd = WORKSPACE_DIR): Promise<McpServerSummary[]> {
  const configPaths = [...getGlobalMcpConfigPaths(AGENT_DIR), ...getProjectMcpConfigPaths(cwd)]
  const seen = new Set<string>()
  const servers: McpServerSummary[] = []

  for (const path of configPaths) {
    const serverMap = getServerMap(readJsonFile(path))
    if (!serverMap) continue

    for (const [name, value] of Object.entries(serverMap)) {
      const server = toMcpServerSummary(name, value, path)
      if (!server || seen.has(server.id)) continue
      seen.add(server.id)
      servers.push(server)
    }
  }

  return servers.sort((left, right) => left.name.localeCompare(right.name))
}
