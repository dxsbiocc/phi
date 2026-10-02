import { existsSync, readFileSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { SkillContent, SkillSourceCategory, SkillSummary } from '../../shared/skillTypes'
import { WORKSPACE_DIR } from './session/sessions'
import {
  createRuntimeResourceLoader,
  createRuntimeSettingsManager,
  getBundledAgentsDir,
  type RuntimeResourceLoader
} from './runtime/runtime-adapter'
import { getGlobalMcpConfigPaths, getPhiAgentDir, getProjectMcpConfigPaths } from './runtime-paths'
import { discoverPhiAgents } from './agents/discovery'
import { getEnablementSnapshot, isCoreSkill, setEnabled, skillEnablementSource } from './enablement'

const AGENT_DIR = getPhiAgentDir()

export type { SkillContent, SkillSourceCategory, SkillSummary } from '../../shared/skillTypes'

export interface McpServerSummary {
  id: string
  name: string
  command?: string
  args?: string[]
  envKeys?: string[]
  url?: string
  transport?: string
  sourcePath?: string
  managed?: boolean
  enabled?: boolean
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

const SKILL_SOURCE_CATEGORY_LABELS: Record<SkillSourceCategory, string> = {
  bundled: '内置',
  'installed-package': '已安装',
  user: '我的',
  project: '项目',
  plugin: '插件'
}
const SKILL_SOURCE_CATEGORY_ORDER: Record<SkillSourceCategory, number> = {
  bundled: 0,
  'installed-package': 1,
  user: 2,
  project: 3,
  plugin: 4
}

export function classifySkillSource(skill: {
  filePath: string
  sourceInfo: {
    source: string
    scope: 'user' | 'project' | 'temporary'
    origin?: string
    baseDir?: string
  }
}): SkillSourceCategory {
  return skillEnablementSource(skill)
}

function toSkillSummary(
  skill: {
    name: string
    description: string
    filePath: string
    disableModelInvocation?: boolean
    hide?: boolean
    sourceInfo: {
      source: string
      scope: 'user' | 'project' | 'temporary'
      origin?: string
      baseDir?: string
    }
  },
  snapshot: ReturnType<typeof getEnablementSnapshot>
): SkillSummary {
  const sourceCategory = classifySkillSource(skill)
  const key = `skill:${skill.name}`
  const core = isCoreSkill(skill.name)
  const sourceDefault = sourceCategory !== 'bundled'
  const globalOverride = Object.hasOwn(snapshot.global, key) ? (snapshot.global[key] ?? null) : null
  const projectOverride = Object.hasOwn(snapshot.project, key)
    ? (snapshot.project[key] ?? null)
    : null
  const globalEnabled = core ? true : (globalOverride ?? sourceDefault)
  const enabled = core ? true : (projectOverride ?? globalEnabled)

  return {
    id: skill.filePath,
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    source: skill.sourceInfo.source,
    ...(skill.sourceInfo.origin ? { sourceId: skill.sourceInfo.origin } : {}),
    scope: skill.sourceInfo.scope,
    sourceCategory,
    sourceCategoryLabel:
      sourceCategory === 'bundled' && isCoreSkill(skill.name)
        ? '内置·核心'
        : SKILL_SOURCE_CATEGORY_LABELS[sourceCategory],
    enabled,
    globalEnabled,
    globalOverride,
    projectOverride,
    core,
    disabled: !enabled
  }
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
  const url = stringValue(value.url)
  const transport = stringValue(value.type)

  if (!command && !args && !envKeys && !url) return null

  return {
    id: `${sourcePath}:${name}`,
    name,
    command,
    args,
    envKeys,
    url,
    transport,
    sourcePath,
    managed: sourcePath === getGlobalMcpConfigPaths(AGENT_DIR)[0],
    enabled: value.enabled !== false,
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
  const match = content.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  return match?.[1] ?? ''
}

function markdownBody(content: string): string {
  const match = content.match(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
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

function phiAgentToPromptAgentSummary(agent: {
  name: string
  description: string
  filePath: string
}): PromptAgentSummary {
  return {
    id: agent.filePath,
    name: agent.name,
    description: agent.description,
    source: 'phi-agent',
    trigger: `调用智能体：${agent.name}`
  }
}

export async function listSkills(cwd = WORKSPACE_DIR): Promise<SkillSummary[]> {
  const loader = createResourceLoader(cwd)
  await loader.reload()
  const { skills } = loader.getSkills()
  const snapshot = getEnablementSnapshot({ projectDir: cwd, agentDir: AGENT_DIR })

  return skills
    .map((skill) => toSkillSummary(skill, snapshot))
    .sort(
      (left, right) =>
        SKILL_SOURCE_CATEGORY_ORDER[left.sourceCategory] -
          SKILL_SOURCE_CATEGORY_ORDER[right.sourceCategory] || left.name.localeCompare(right.name)
    )
}

/** Global catalog only; never scan a remote project's local SDK anchor. */
export async function listGlobalSkills(): Promise<SkillSummary[]> {
  return (await listSkills(AGENT_DIR)).filter((skill) => skill.scope !== 'project')
}

export async function readGlobalSkillContent(filePath: string): Promise<SkillContent> {
  const available = await listGlobalSkills()
  if (!available.some((skill) => resolve(skill.filePath) === resolve(filePath))) {
    throw new Error('远程项目级 Skill 暂不可用')
  }
  return readSkillContent(filePath, AGENT_DIR)
}

async function findCatalogSkill(
  filePath: string,
  cwd = WORKSPACE_DIR
): Promise<{
  skill: {
    name: string
    description: string
    filePath: string
    disableModelInvocation?: boolean
    sourceInfo: {
      source: string
      scope: 'user' | 'project' | 'temporary'
      origin?: string
      baseDir?: string
    }
  }
  sourceCategory: SkillSourceCategory
}> {
  const loader = createResourceLoader(cwd)
  await loader.reload()
  const { skills } = loader.getSkills()
  const normalizedTarget = resolve(filePath)
  const skill = skills.find((candidate) => resolve(candidate.filePath) === normalizedTarget)

  if (!skill) {
    throw new Error('Skill file is not available in the current resource catalog')
  }

  return {
    skill,
    sourceCategory: classifySkillSource(skill)
  }
}

export async function readSkillContent(
  filePath: string,
  cwd = WORKSPACE_DIR
): Promise<SkillContent> {
  const { skill } = await findCatalogSkill(filePath, cwd)

  return {
    filePath: skill.filePath,
    content: readFileSync(skill.filePath, 'utf-8')
  }
}

export async function setSkillDisabled(
  filePath: string,
  disabled: boolean,
  cwd = WORKSPACE_DIR
): Promise<SkillSummary[]> {
  const { skill, sourceCategory } = await findCatalogSkill(filePath, cwd)

  if (sourceCategory === 'plugin') throw new Error('Plugin skills are managed on the Plugins page')
  setEnabled(`skill:${skill.name}`, !disabled, { agentDir: AGENT_DIR })
  return listSkills(cwd)
}

export async function deleteSkill(filePath: string, cwd = WORKSPACE_DIR): Promise<SkillSummary[]> {
  const { skill, sourceCategory } = await findCatalogSkill(filePath, cwd)

  if (sourceCategory === 'bundled') {
    throw new Error('System skills cannot be deleted')
  }
  if (sourceCategory === 'plugin') {
    throw new Error('Plugin skills must be removed from the plugin manager')
  }
  if (sourceCategory === 'installed-package') {
    throw new Error('Installed package skills must be removed from the package manager')
  }

  rmSync(dirname(skill.filePath), { recursive: true, force: false })
  return listSkills(cwd)
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

  for (const agent of discoverPhiAgents({
    cwd,
    agentDir: AGENT_DIR,
    bundledDir: getBundledAgentsDir()
  }).agents) {
    addAgent(phiAgentToPromptAgentSummary(agent))
  }

  for (const agent of listCodexPromptAgents()) {
    addAgent(agent)
  }

  return agents.sort((left, right) => left.name.localeCompare(right.name))
}

async function listMcpServersFromPaths(configPaths: string[]): Promise<McpServerSummary[]> {
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

export async function listGlobalMcpServers(): Promise<McpServerSummary[]> {
  return listMcpServersFromPaths(getGlobalMcpConfigPaths(AGENT_DIR))
}

export async function listMcpServers(cwd = WORKSPACE_DIR): Promise<McpServerSummary[]> {
  return listMcpServersFromPaths([
    ...getGlobalMcpConfigPaths(AGENT_DIR),
    ...getProjectMcpConfigPaths(cwd)
  ])
}
