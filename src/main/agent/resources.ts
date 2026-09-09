import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
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

export interface PromptAgentSummary {
  id: string
  name: string
  description: string
  source: string
  trigger: string
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

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function promptAgentTrigger(name: string): string {
  return `/prompts:${name}`
}

function promptListFromResource(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord)
  }
  if (!isRecord(value)) return []

  for (const key of ['prompts', 'items', 'all']) {
    const list = value[key]
    if (Array.isArray(list)) {
      return list.filter(isRecord)
    }
  }

  return []
}

function toPromptAgentSummary(value: unknown): PromptAgentSummary | null {
  if (!isRecord(value)) return null

  const name = stringValue(value.name)
  if (!name) return null

  const source = stringValue(value.source) ?? 'prompt'
  return {
    id: `${source}:${name}`,
    name,
    description: stringValue(value.description) ?? '',
    source,
    trigger: promptAgentTrigger(name)
  }
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

function configLineValue(content: string, key: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*${key}\\s*[:=]\\s*(.+?)\\s*$`))
    if (!match) continue

    let value = match[1]?.trim() ?? ''
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    return value.replace(/\\"/g, '"').replace(/\\'/g, "'").trim()
  }

  return undefined
}

function markdownFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return match?.[1] ?? ''
}

function markdownBody(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---/)
  return match ? content.slice(match[0].length) : content
}

function markdownDescription(content: string): string {
  const frontmatterDescription = configLineValue(markdownFrontmatter(content), 'description')
  if (frontmatterDescription) return frontmatterDescription

  const firstBodyLine = markdownBody(content)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^#+\s*/, ''))
    .find(Boolean)

  if (!firstBodyLine) return ''
  return firstBodyLine.length > 60 ? `${firstBodyLine.slice(0, 60)}...` : firstBodyLine
}

function listFiles(root: string, extensions: Set<string>): string[] {
  const files: string[] = []

  const walk = (dir: string): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if ((entry.isFile() || entry.isSymbolicLink()) && extensions.has(extname(entry.name))) {
        files.push(path)
      }
    }
  }

  walk(root)
  return files.sort((left, right) => left.localeCompare(right))
}

function promptAgentFromMarkdown(path: string, source: string): PromptAgentSummary | null {
  try {
    const name = basename(path, extname(path))
    return {
      id: path,
      name,
      description: markdownDescription(readFileSync(path, 'utf-8')),
      source,
      trigger: promptAgentTrigger(name)
    }
  } catch {
    return null
  }
}

function promptAgentFromToml(path: string, source: string): PromptAgentSummary | null {
  try {
    const content = readFileSync(path, 'utf-8')
    const name = configLineValue(content, 'name') ?? basename(path, extname(path))
    return {
      id: path,
      name,
      description: configLineValue(content, 'description') ?? '',
      source,
      trigger: promptAgentTrigger(name)
    }
  } catch {
    return null
  }
}

function getCodexAgentDir(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

function listCodexPromptAgents(): PromptAgentSummary[] {
  const codexDir = getCodexAgentDir()
  const promptAgents = listFiles(join(codexDir, 'prompts'), new Set(['.md']))
    .map((path) => promptAgentFromMarkdown(path, 'codex-prompt'))
    .filter((agent): agent is PromptAgentSummary => agent !== null)
  const configuredAgents = listFiles(join(codexDir, 'agents'), new Set(['.toml']))
    .map((path) => promptAgentFromToml(path, 'codex-agent'))
    .filter((agent): agent is PromptAgentSummary => agent !== null)

  return [...promptAgents, ...configuredAgents]
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

export async function listPromptAgents(cwd = WORKSPACE_DIR): Promise<PromptAgentSummary[]> {
  const loader = createResourceLoader(cwd)
  await loader.reload()

  const seen = new Set<string>()
  const agents: PromptAgentSummary[] = []
  const addAgent = (agent: PromptAgentSummary): void => {
    if (seen.has(agent.name)) return
    seen.add(agent.name)
    agents.push(agent)
  }

  for (const prompt of promptListFromResource(loader.getPrompts())) {
    const agent = toPromptAgentSummary(prompt)
    if (agent) addAgent(agent)
  }

  for (const agent of listCodexPromptAgents()) {
    addAgent(agent)
  }

  return agents.sort((left, right) => left.name.localeCompare(right.name))
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
