import { existsSync, readFileSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { SkillContent, SkillSourceCategory, SkillSummary } from '../../shared/skillTypes'
import type { PromptAgentSummary } from '../../shared/promptAgentTypes'
import { WORKSPACE_DIR } from './session/sessions'
import {
  getBundledAgentsDir,
  getBundledSkillsDir,
  getCoreSkillDirs
} from './runtime/runtime-adapter'
import { isInjectedMcpServer, readDisabledMcpServerNames } from './mcp-connectors'
import {
  getGlobalMcpConfigPaths,
  getPhiAgentDir,
  getProjectMcpConfigPaths,
  LEGACY_PROJECT_CONFIG_DIR_NAMES,
  PHI_PROJECT_CONFIG_DIR_NAME
} from './runtime-paths'
import { readAppSettings } from './app-settings'
import { discoverPhiAgents } from './agents/discovery'
import { getEnablementSnapshot, isCoreSkill, setEnabled, skillEnablementSource } from './enablement'
import { parseSkillFile } from './content/skill'
import { resolveCuratedResourceIcon } from './curated-icons'
import { findResourceIcon, findResourceIconSidecar } from './resource-icons'
import type { ResourceIconRef } from '../../shared/resourceIconTypes'
import { listActiveMcpPackages } from './packages/mcp-store'
import { listActiveSkillPackages } from './packages/store'
import { listInstalledPlugins } from './plugins/loader'
import { readManagedMarker } from './mcp/stdio-environment'

import { isRecord } from '../../shared/guards'
const AGENT_DIR = getPhiAgentDir()

export type { SkillContent, SkillSourceCategory, SkillSummary } from '../../shared/skillTypes'
export type { PromptAgentSummary } from '../../shared/promptAgentTypes'

export interface McpServerSummary {
  icon?: ResourceIconRef
  id: string
  name: string
  /** Catalog title of the connector this server came from, when known. */
  title?: string
  connectorId?: string
  packageId?: string
  category?: string
  command?: string
  args?: string[]
  envKeys?: string[]
  url?: string
  transport?: string
  sourcePath?: string
  managed?: boolean
  enabled?: boolean
  userDisabled?: boolean
  userStdio?: boolean
  status: 'configured'
}

type UnknownRecord = Record<string, unknown>

interface CatalogSkillEntry {
  name: string
  description: string
  filePath: string
  metadata?: Pick<SkillSummary, 'deprecated' | 'environment' | 'version'>
  sourceInfo: {
    source: string
    scope: 'user' | 'project' | 'temporary'
    origin?: string
    baseDir?: string
  }
}

function readCatalogSkillFile(
  filePath: string,
  sourceInfo: CatalogSkillEntry['sourceInfo']
): CatalogSkillEntry | null {
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = parseSkillFile(raw)
    if (parsed.ok) {
      const fm = parsed.frontmatter
      const name = stringValue(fm.name) ?? basename(dirname(filePath))
      const description = stringValue(fm.description) ?? ''
      const phi = isRecord(fm.phi) ? fm.phi : undefined
      const meta = isRecord(fm.metadata) ? fm.metadata : undefined
      const deprecated = stringValue(phi?.deprecated)
      const environment = stringValue(phi?.environment)
      const version = stringValue(meta?.version)
      const metadata =
        deprecated || environment || version
          ? {
              ...(deprecated ? { deprecated } : {}),
              ...(environment ? { environment } : {}),
              ...(version ? { version } : {})
            }
          : undefined
      return { name, description, filePath, ...(metadata ? { metadata } : {}), sourceInfo }
    }
    const name = configLineValue(raw, 'name') ?? basename(dirname(filePath))
    const description = configLineValue(raw, 'description') ?? ''
    return { name, description, filePath, sourceInfo }
  } catch {
    return null
  }
}

function listSkillFilesInRoot(rootDir: string): string[] {
  if (!existsSync(rootDir)) return []
  let entries: Dirent[]
  try {
    entries = readdirSync(rootDir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(rootDir, entry.name)
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const nested = join(full, 'SKILL.md')
      if (existsSync(nested)) files.push(nested)
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      files.push(full)
    }
  }
  return files
}

function discoverCatalogSkills(cwd: string): {
  skills: CatalogSkillEntry[]
  pluginDirectories: Map<string, string>
} {
  const seenFiles = new Set<string>()
  const seenNames = new Set<string>()
  const skills: CatalogSkillEntry[] = []

  const addEntry = (entry: CatalogSkillEntry | null): void => {
    if (!entry) return
    const normalized = resolve(entry.filePath)
    if (seenFiles.has(normalized) || seenNames.has(entry.name)) return
    seenFiles.add(normalized)
    seenNames.add(entry.name)
    skills.push(entry)
  }

  // 1. Installed standalone skill packages
  for (const pkg of listActiveSkillPackages(AGENT_DIR)) {
    addEntry(
      readCatalogSkillFile(join(pkg.dir, 'SKILL.md'), {
        source: 'installed-package',
        scope: 'user',
        origin: pkg.id,
        baseDir: pkg.dir
      })
    )
  }

  // 2. Core bundled skills (create-wrapper, environment-setup, ...)
  const bundledRoot = getBundledSkillsDir()
  for (const dir of getCoreSkillDirs()) {
    addEntry(
      readCatalogSkillFile(join(dir, 'SKILL.md'), {
        source: 'bundled',
        scope: 'user',
        origin: 'resources',
        baseDir: bundledRoot
      })
    )
  }

  // 3. Installed enabled plugin skills
  const installedPlugins = listInstalledPlugins({ agentDir: AGENT_DIR })
  const pluginDirectories = new Map(installedPlugins.map((plugin) => [plugin.id, plugin.dir]))
  for (const plugin of installedPlugins) {
    if (!plugin.enabled) continue
    for (const dir of plugin.components.skills) {
      addEntry(
        readCatalogSkillFile(join(dir, 'SKILL.md'), {
          source: 'phi-plugin',
          scope: 'user',
          origin: plugin.id,
          baseDir: dir
        })
      )
    }
  }

  // 4. Project-local skills (.phi/skills, .omp/skills, .pi/skills)
  const projectConfigDirs = [PHI_PROJECT_CONFIG_DIR_NAME, ...LEGACY_PROJECT_CONFIG_DIR_NAMES]
  for (const configDir of projectConfigDirs) {
    const baseDir = join(cwd, configDir, 'skills')
    for (const filePath of listSkillFilesInRoot(baseDir)) {
      addEntry(
        readCatalogSkillFile(filePath, {
          source: 'path',
          scope: 'project',
          baseDir
        })
      )
    }
  }

  // 5. User global skills (~/.phi/skills)
  const userSkillsDir = join(AGENT_DIR, 'skills')
  for (const filePath of listSkillFilesInRoot(userSkillsDir)) {
    addEntry(
      readCatalogSkillFile(filePath, {
        source: 'path',
        scope: 'user',
        baseDir: userSkillsDir
      })
    )
  }

  return { skills, pluginDirectories }
}

function listCompatiblePromptTemplates(cwd: string): PromptAgentSummary[] {
  const results: PromptAgentSummary[] = []
  const projectDirs = [PHI_PROJECT_CONFIG_DIR_NAME, ...LEGACY_PROJECT_CONFIG_DIR_NAMES].map((dir) =>
    join(cwd, dir, 'prompts')
  )
  for (const dir of projectDirs) {
    for (const filePath of listFiles(dir, new Set(['.md']))) {
      const agent = promptAgentFromMarkdown(filePath, 'project-prompt')
      if (agent) results.push(agent)
    }
  }
  for (const filePath of listFiles(join(AGENT_DIR, 'prompts'), new Set(['.md']))) {
    const agent = promptAgentFromMarkdown(filePath, 'user-prompt')
    if (agent) results.push(agent)
  }
  return results
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

/** Read declared metadata once; unreadable or malformed fields are omitted. */
function skillMetadata(
  filePath: string
): Pick<SkillSummary, 'deprecated' | 'environment' | 'version'> | undefined {
  try {
    const parsed = parseSkillFile(readFileSync(filePath, 'utf8'))
    if (!parsed.ok) return undefined
    const phi = isRecord(parsed.frontmatter.phi) ? parsed.frontmatter.phi : undefined
    const metadata = isRecord(parsed.frontmatter.metadata) ? parsed.frontmatter.metadata : undefined
    const deprecated = stringValue(phi?.deprecated)
    const environment = stringValue(phi?.environment)
    const version = stringValue(metadata?.version)
    return {
      ...(deprecated ? { deprecated } : {}),
      ...(environment ? { environment } : {}),
      ...(version ? { version } : {})
    }
  } catch {
    return undefined
  }
}

function toSkillSummary(
  skill: CatalogSkillEntry,
  snapshot: ReturnType<typeof getEnablementSnapshot>,
  pluginDirectory?: string
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
  const metadata = skill.metadata ?? skillMetadata(skill.filePath)
  const icon =
    findResourceIcon(
      dirname(skill.filePath),
      sourceCategory === 'plugin' && pluginDirectory ? [pluginDirectory] : []
    ) ??
    resolveCuratedResourceIcon(
      'skill',
      `${sourceCategory}:${skill.sourceInfo.origin ?? skill.sourceInfo.source}:${skill.name}`
    )

  return {
    id: skill.filePath,
    ...(icon ? { icon } : {}),
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
    disabled: !enabled,
    ...metadata
  }
}

function toMcpServerSummary(
  name: string,
  value: unknown,
  sourcePath: string,
  userDisabled: boolean
): McpServerSummary | null {
  if (!isRecord(value)) return null

  const userStdio = value.phiOrigin === 'user-stdio'
  const userPresentation = userStdio ? userStdioPresentation(value) : undefined
  const command = userStdio
    ? userPresentation?.command
    : typeof value.command === 'string'
      ? value.command
      : undefined
  const args = userStdio ? userPresentation?.args : toStringArray(value.args)
  const envKeys = userStdio
    ? userPresentation?.envKeys
    : isRecord(value.env)
      ? Object.keys(value.env).sort()
      : undefined
  const url = stringValue(value.url)
  const transport = stringValue(value.type)
  const packageId = stringValue(value.phiPackage)

  if (!command && !args && !envKeys && !url) return null

  return {
    id: `${sourcePath}:${name}`,
    name,
    ...(packageId ? { connectorId: packageId, packageId } : {}),
    command,
    args,
    envKeys,
    url,
    transport,
    sourcePath,
    managed: sourcePath === getGlobalMcpConfigPaths(AGENT_DIR)[0],
    enabled: isInjectedMcpServer(name, value, userDisabled),
    userDisabled,
    ...(userStdio ? { userStdio: true } : {}),
    status: 'configured'
  }
}

function userStdioPresentation(value: UnknownRecord): {
  command?: string
  args?: string[]
  envKeys?: string[]
} {
  const metadata = isRecord(value.phiUser) ? value.phiUser : undefined
  const userEnv = metadata && isRecord(metadata.env) ? metadata.env : undefined
  const envKeys = userEnv
    ? Object.entries(userEnv)
        .filter(([, entry]) => typeof entry === 'string')
        .map(([name]) => name)
        .sort()
    : undefined
  const marker = readManagedMarker(value)
  if (marker && metadata && isRecord(metadata.runtime) && metadata.runtime.kind === 'environment') {
    return {
      command: marker.command,
      args: [...marker.args],
      ...(envKeys?.length ? { envKeys } : {})
    }
  }
  if (
    value.command === '/usr/bin/env' &&
    Array.isArray(value.args) &&
    value.args.every((entry) => typeof entry === 'string') &&
    value.args[0] === '-i' &&
    metadata &&
    isRecord(metadata.runtime) &&
    (metadata.runtime.kind === 'host' || metadata.runtime.kind === 'bun')
  ) {
    let commandIndex = 1
    while (/^[A-Z_][A-Z0-9_]*=/u.test(value.args[commandIndex] ?? '')) commandIndex += 1
    const command = value.args[commandIndex]
    if (metadata.runtime.kind === 'bun') {
      const subcommand = value.args[commandIndex + 1]
      return {
        ...(subcommand === 'x' || subcommand === 'run' ? { command: 'bun' } : {}),
        ...(subcommand === 'x' || subcommand === 'run'
          ? { args: value.args.slice(commandIndex + 1) }
          : {}),
        ...(envKeys?.length ? { envKeys } : {})
      }
    }
    return {
      ...(command ? { command } : {}),
      ...(command ? { args: value.args.slice(commandIndex + 1) } : {}),
      ...(envKeys?.length ? { envKeys } : {})
    }
  }
  return envKeys?.length ? { envKeys } : {}
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
  const icon = findResourceIconSidecar(agent.filePath)
  return {
    ...(icon ? { icon } : {}),
    id: agent.filePath,
    name: agent.name,
    description: agent.description,
    source: 'phi-agent',
    trigger: `调用智能体：${agent.name}`
  }
}

export async function listSkills(cwd = WORKSPACE_DIR): Promise<SkillSummary[]> {
  const { skills, pluginDirectories } = discoverCatalogSkills(cwd)
  const snapshot = getEnablementSnapshot({ projectDir: cwd, agentDir: AGENT_DIR })

  return skills
    .map((skill) =>
      toSkillSummary(skill, snapshot, pluginDirectories.get(skill.sourceInfo.origin ?? ''))
    )
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
  skill: CatalogSkillEntry
  sourceCategory: SkillSourceCategory
}> {
  const { skills } = discoverCatalogSkills(cwd)
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

export async function listPromptAgents(
  cwd = WORKSPACE_DIR,
  options: { includeCompatible?: boolean } = {}
): Promise<PromptAgentSummary[]> {
  const includeCompatible =
    options.includeCompatible ?? readAppSettings(AGENT_DIR).showCompatibleAgents

  const seen = new Set<string>()
  const agents: PromptAgentSummary[] = []
  const addAgent = (agent: PromptAgentSummary): void => {
    if (seen.has(agent.name)) return
    seen.add(agent.name)
    const icon = agent.icon ?? resolveCuratedResourceIcon('agent', `${agent.source}:${agent.name}`)
    agents.push(icon ? { ...agent, icon } : agent)
  }

  if (includeCompatible) {
    for (const agent of listCompatiblePromptTemplates(cwd)) {
      addAgent(agent)
    }
  }

  for (const agent of discoverPhiAgents({
    cwd,
    agentDir: AGENT_DIR,
    bundledDir: getBundledAgentsDir()
  }).agents.filter(
    (agent) =>
      agent.invocation !== 'host' &&
      agent.name !== 'General' &&
      (includeCompatible || agent.source === 'phi')
  )) {
    addAgent(phiAgentToPromptAgentSummary(agent))
  }

  if (includeCompatible) {
    for (const agent of listCodexPromptAgents()) {
      addAgent(agent)
    }
  }

  return agents.sort((left, right) => left.name.localeCompare(right.name))
}

async function listMcpServersFromPaths(configPaths: string[]): Promise<McpServerSummary[]> {
  const seen = new Set<string>()
  const servers: McpServerSummary[] = []
  const disabled = new Set(readDisabledMcpServerNames())
  const installedRoots = new Map(
    listActiveMcpPackages(AGENT_DIR).map((entry) => [entry.id, entry.dir])
  )

  for (const path of configPaths) {
    const serverMap = getServerMap(readJsonFile(path))
    if (!serverMap) continue

    for (const [name, value] of Object.entries(serverMap)) {
      const server = toMcpServerSummary(name, value, path, disabled.has(name))
      if (!server || seen.has(server.id)) continue
      const installedRoot = server.packageId ? installedRoots.get(server.packageId) : undefined
      const icon = installedRoot ? findResourceIcon(installedRoot) : undefined
      if (icon) server.icon = icon
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
