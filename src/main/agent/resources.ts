import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { WORKSPACE_DIR } from './session/sessions'
import {
  createRuntimeResourceLoader,
  createRuntimeSettingsManager,
  type RuntimeResourceLoader
} from './runtime/runtime-adapter'
import { getGlobalMcpConfigPaths, getPhiAgentDir, getProjectMcpConfigPaths } from './runtime-paths'

const AGENT_DIR = getPhiAgentDir()

export type SkillSourceCategory = 'system' | 'third-party' | 'user' | 'generated'

export interface SkillSummary {
  id: string
  name: string
  description: string
  filePath: string
  source: string
  scope: 'user' | 'project' | 'temporary'
  sourceCategory: SkillSourceCategory
  sourceCategoryLabel: string
  disabled: boolean
}

export interface SkillContent {
  filePath: string
  content: string
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

const SKILL_SOURCE_CATEGORY_LABELS: Record<SkillSourceCategory, string> = {
  system: 'System',
  'third-party': 'Plugin',
  user: 'User',
  generated: 'Agent'
}
const SKILL_SOURCE_CATEGORY_ORDER: Record<SkillSourceCategory, number> = {
  system: 0,
  'third-party': 1,
  user: 2,
  generated: 3
}

function normalizedPath(value: string | undefined): string {
  return value ? value.replaceAll('\\', '/').toLowerCase() : ''
}

function classifySkillSource(skill: {
  filePath: string
  sourceInfo: {
    source: string
    scope: 'user' | 'project' | 'temporary'
    origin?: string
    baseDir?: string
  }
}): SkillSourceCategory {
  const filePath = normalizedPath(skill.filePath)
  const baseDir = normalizedPath(skill.sourceInfo.baseDir)
  const source = skill.sourceInfo.source.toLowerCase()
  const origin = skill.sourceInfo.origin?.toLowerCase() ?? ''
  const haystack = `${filePath} ${baseDir} ${source} ${origin}`

  if (
    haystack.includes('/.agents/skills/') ||
    source.startsWith('agents') ||
    origin.includes('generated')
  ) {
    return 'generated'
  }

  if (
    haystack.includes('/resources/skills/') ||
    (source === 'bundled' && origin.includes('resources'))
  ) {
    return 'system'
  }

  if (
    haystack.includes('/plugins/cache/') ||
    haystack.includes('/plugins/') ||
    haystack.includes('/skills/.system/') ||
    haystack.includes('/openai-bundled/') ||
    haystack.includes('/openai-primary-runtime/') ||
    source.includes('plugin') ||
    source.includes('package') ||
    source.includes('npm') ||
    source.includes('system') ||
    source.includes('builtin')
  ) {
    return 'third-party'
  }

  return 'user'
}

function toSkillSummary(skill: {
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
}): SkillSummary {
  const sourceCategory = classifySkillSource(skill)

  return {
    id: skill.filePath,
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    source: skill.sourceInfo.source,
    scope: skill.sourceInfo.scope,
    sourceCategory,
    sourceCategoryLabel: SKILL_SOURCE_CATEGORY_LABELS[sourceCategory],
    disabled: skillDisabledFromFile(skill)
  }
}

function metadataBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function skillDisabledFromFile(skill: {
  filePath: string
  disableModelInvocation?: boolean
  hide?: boolean
}): boolean {
  const fallback = skill.disableModelInvocation === true || skill.hide === true

  try {
    const metadata = parseFrontmatterRecord(
      markdownFrontmatter(readFileSync(skill.filePath, 'utf-8'))
    )
    const values = [
      metadataBoolean(metadata.disableModelInvocation),
      metadataBoolean(metadata.hide),
      metadataBoolean(metadata['disable-model-invocation'])
    ].filter((value): value is boolean => value !== undefined)

    return values.length > 0 ? values.some(Boolean) : fallback
  } catch {
    return fallback
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
  const match = content.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  return match?.[1] ?? ''
}

function markdownBody(content: string): string {
  const match = content.match(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
  return match ? content.slice(match[0].length) : content
}

function parseFrontmatterRecord(frontmatter: string): UnknownRecord {
  const parsed = frontmatter.trim() ? parseYaml(frontmatter) : {}
  if (!isRecord(parsed)) {
    throw new Error('Skill metadata must be a YAML mapping')
  }
  return parsed
}

function skillMarkdownWithMetadata(content: string, patch: UnknownRecord): string {
  const frontmatter = markdownFrontmatter(content)
  const body = markdownBody(content)
  const metadata = {
    ...parseFrontmatterRecord(frontmatter),
    ...patch
  }
  const nextFrontmatter = stringifyYaml(metadata).trimEnd()
  const separator = body.startsWith('\n') || body.startsWith('\r\n') ? '' : '\n'
  return `---\n${nextFrontmatter}\n---${separator}${body}`
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
    .map(toSkillSummary)
    .sort(
      (left, right) =>
        SKILL_SOURCE_CATEGORY_ORDER[left.sourceCategory] -
          SKILL_SOURCE_CATEGORY_ORDER[right.sourceCategory] || left.name.localeCompare(right.name)
    )
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

  if (sourceCategory === 'system') {
    throw new Error('System skills cannot be modified')
  }

  const content = readFileSync(skill.filePath, 'utf-8')
  writeFileSync(
    skill.filePath,
    skillMarkdownWithMetadata(content, { disableModelInvocation: disabled, hide: disabled }),
    'utf-8'
  )
  return listSkills(cwd)
}

export async function deleteSkill(filePath: string, cwd = WORKSPACE_DIR): Promise<SkillSummary[]> {
  const { skill, sourceCategory } = await findCatalogSkill(filePath, cwd)

  if (sourceCategory === 'system') {
    throw new Error('System skills cannot be deleted')
  }
  if (sourceCategory === 'third-party') {
    throw new Error('Plugin skills must be removed from the plugin manager')
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
