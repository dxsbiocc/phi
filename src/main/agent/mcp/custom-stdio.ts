import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'

import type {
  LocalMcpConnectorRequest,
  LocalMcpRuntime,
  LocalMcpRuntimeOption
} from '../../../shared/mcpConnectorCatalog'
import {
  describeEnvironment,
  bundledEnvironmentsDir,
  EnvironmentNotReadyError,
  readyEnvironment
} from '../content/environment-refs'
import { getRuntimeRoot } from '../envs/runtime'
import { API_KEY_CONNECTOR_IDS } from '../mcp-key-credentials'
import { sanitizeHostEnvironment } from '../envs/execution'
import { getPhiAgentDir } from '../runtime-paths'
import { resolveBunExecutable, workerPathWithBun } from '../engine/bun-executable'
import type { ConfiguredStdioMcpToolsDependencies } from '../engine/mcp/configured-stdio-tools'
import { readMcpConfig, writeMcpConfig, type McpConfig } from './package-config'
import { validateName } from './connector-name'
import {
  managedStdioServer,
  type EnvironmentLookup,
  type ManagedStdioEntry
} from './stdio-environment'

const ENVIRONMENT_REF = /^phi:[a-z][a-z0-9-]{0,62}@(0|[1-9][0-9]*)$/
const ENVIRONMENT_COMMAND = /^[A-Za-z0-9_+.-]+$/
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/
const MAX_ARGUMENTS = 64
const MAX_VALUE_LENGTH = 4096
const HOST_CONTRACT_NAMES = new Set(['PATH', 'HOME', 'LANG', 'TMPDIR'])
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

export interface LocalConnectorValidationOptions {
  agentDir?: string
  catalogIds?: readonly string[]
  fileSystem?: LocalConnectorFileSystem
}

export interface LocalConnectorFileSystem {
  access(path: string, mode: number): void
  realpath(path: string): string
  stat(path: string): { isDirectory(): boolean; isFile(): boolean }
  readConfig(agentDir: string): McpConfig
  writeConfig(config: McpConfig, agentDir: string): void
}

export interface AddLocalMcpConnectorDependencies extends LocalStdioEntryLookup {
  agentDir?: string
  runtimeRoot?: string
  catalogIds?: readonly string[]
  clock?: ConfiguredStdioMcpToolsDependencies['clock']
  fileSystem?: LocalConnectorFileSystem
  probe?: (request: {
    name: string
    entry: LocalStdioEntry
    environment: EnvironmentLookup
  }) => Promise<string[]>
}

const localConnectorFileSystem: LocalConnectorFileSystem = {
  access: accessSync,
  realpath: realpathSync,
  stat: statSync,
  readConfig: readMcpConfig,
  writeConfig: writeMcpConfig
}

const addQueues = new Map<string, Promise<void>>()

export async function listLocalMcpRuntimes(
  options: Partial<EnvironmentLookup> & Pick<LocalStdioEntryLookup, 'resolveBunExecutable'> = {}
): Promise<LocalMcpRuntimeOption[]> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = options.root ?? getRuntimeRoot(agentDir)
  const environmentsDir = options.environmentsDir ?? bundledEnvironmentsDir()
  let refs: string[] = []
  try {
    refs = readdirSync(environmentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('phi-'))
      .map((entry) => `phi:${entry.name.slice('phi-'.length)}@1`)
      .filter((ref) => ENVIRONMENT_REF.test(ref))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    refs = []
  }
  const runtimes: LocalMcpRuntimeOption[] = refs.flatMap((ref) => {
    try {
      const descriptor = describeEnvironment(ref, {
        agentDir,
        environmentsDir,
        platform: options.platform
      })
      readyEnvironment(root, descriptor)
      return [{ ref, label: descriptor.spec.name || ref }]
    } catch {
      return []
    }
  })
  try {
    const bun = resolvedBunExecutable(options)
    if (isAbsolute(bun)) {
      runtimes.push({ ref: 'bun', label: 'Phi 内置 Bun', kind: 'bun' })
    }
  } catch {
    // A missing bundled runtime hides only the Bun option; managed environments remain usable.
  }
  return runtimes
}

export function removeLocalMcpConnector(
  name: string,
  options: { agentDir?: string; fileSystem?: LocalConnectorFileSystem } = {}
): void {
  const validatedName = validateName(name)
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const fileSystem = options.fileSystem ?? localConnectorFileSystem
  const config = fileSystem.readConfig(agentDir)
  const servers = config.mcpServers ?? {}
  const existing = servers[validatedName]
  if (!isRecord(existing) || existing.phiOrigin !== 'user-stdio') {
    throw new Error('只能移除通过本地 stdio 添加的连接器')
  }
  const remaining = Object.fromEntries(
    Object.entries(servers).filter(([entryName]) => entryName !== validatedName)
  )
  fileSystem.writeConfig({ ...config, mcpServers: remaining }, agentDir)
}

export async function addLocalMcpConnector(
  raw: unknown,
  deps: Partial<AddLocalMcpConnectorDependencies> = {}
): Promise<{ tools: string[] }> {
  const queueName = validateName(isRecord(raw) ? (raw.name as string) : (undefined as never))
  const previous = addQueues.get(queueName) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.catch(() => undefined).then(() => gate)
  addQueues.set(queueName, queued)
  await previous.catch(() => undefined)
  try {
    return await addLocalMcpConnectorUnlocked(raw, deps)
  } finally {
    release()
    if (addQueues.get(queueName) === queued) addQueues.delete(queueName)
  }
}

async function addLocalMcpConnectorUnlocked(
  raw: unknown,
  deps: Partial<AddLocalMcpConnectorDependencies>
): Promise<{ tools: string[] }> {
  const agentDir = deps.agentDir ?? getPhiAgentDir()
  const runtimeRoot = deps.runtimeRoot ?? deps.root ?? getRuntimeRoot(agentDir)
  const catalogIds = deps.catalogIds ?? []
  const request = validateLocalConnectorRequest(raw, {
    agentDir,
    catalogIds,
    fileSystem: deps.fileSystem
  })
  const environment: EnvironmentLookup = {
    root: runtimeRoot,
    ...(deps.agentDir ? { agentDir } : {}),
    ...(deps.environmentsDir ? { environmentsDir: deps.environmentsDir } : {}),
    ...(deps.platform ? { platform: deps.platform } : {})
  }
  let entry: LocalStdioEntry
  try {
    entry = buildLocalStdioEntry(request, {
      ...environment,
      baseEnv: deps.baseEnv,
      resolveBunExecutable: deps.resolveBunExecutable
    })
  } catch (error) {
    if (error instanceof EnvironmentNotReadyError) {
      throw new Error('运行环境尚未就绪，请先在环境页构建')
    }
    throw error
  }
  const probe =
    deps.probe ??
    (async (probeRequest) => {
      const { listConfiguredStdioMcpTools } = await import('../engine/mcp/configured-stdio-tools')
      return listConfiguredStdioMcpTools(probeRequest, { clock: deps.clock })
    })
  const tools = await probe({ name: request.name, entry, environment })
  const fileSystem = deps.fileSystem ?? localConnectorFileSystem
  const config = fileSystem.readConfig(agentDir)
  const servers = config.mcpServers ?? {}
  if (servers[request.name] !== undefined) {
    throw new Error(`已有名为 ${request.name} 的 MCP 配置`)
  }
  fileSystem.writeConfig(
    {
      ...config,
      mcpServers: { ...servers, [request.name]: { ...entry, enabled: true } }
    },
    agentDir
  )
  return { tools: [...tools] }
}

export interface LocalStdioUserMetadata {
  runtime: LocalMcpRuntime
  env: Record<string, string>
}

interface LocalStdioOwnership {
  phiOrigin: 'user-stdio'
  phiUser: LocalStdioUserMetadata
}

export type EnvironmentLocalStdioEntry = ManagedStdioEntry & LocalStdioOwnership

export type HostLocalStdioEntry = LocalStdioOwnership & {
  type: 'stdio'
  command: '/usr/bin/env'
  args: string[]
  env: Record<string, string>
  cwd?: string
}

export type BunLocalStdioEntry = HostLocalStdioEntry

export type LocalStdioEntry = EnvironmentLocalStdioEntry | HostLocalStdioEntry | BunLocalStdioEntry

export interface LocalStdioEntryLookup extends EnvironmentLookup {
  baseEnv?: NodeJS.ProcessEnv
  resolveBunExecutable?: () => string
}

export function buildLocalStdioEntry(
  request: LocalMcpConnectorRequest & { runtime: { kind: 'environment'; ref: string } },
  lookup: LocalStdioEntryLookup
): EnvironmentLocalStdioEntry
export function buildLocalStdioEntry(
  request: LocalMcpConnectorRequest & { runtime: { kind: 'host' } },
  lookup: LocalStdioEntryLookup
): HostLocalStdioEntry
export function buildLocalStdioEntry(
  request: LocalMcpConnectorRequest & { runtime: { kind: 'bun' } },
  lookup: LocalStdioEntryLookup
): BunLocalStdioEntry
export function buildLocalStdioEntry(
  request: LocalMcpConnectorRequest,
  lookup: LocalStdioEntryLookup
): LocalStdioEntry
export function buildLocalStdioEntry(
  request: LocalMcpConnectorRequest,
  lookup: LocalStdioEntryLookup
): LocalStdioEntry {
  const phiUser = { runtime: { ...request.runtime }, env: { ...request.env } }
  if (request.runtime.kind === 'host' || request.runtime.kind === 'bun') {
    const overridden = Object.keys(request.env).find((name) => HOST_CONTRACT_NAMES.has(name))
    if (overridden) throw new Error(`本地 stdio 环境变量不能覆盖 ${overridden}`)
    const baseEnv = lookup.baseEnv ?? process.env
    let command = request.command
    let path = validHostValue(baseEnv.PATH) ? baseEnv.PATH : SYSTEM_PATH
    const forced: Record<string, string> = {}
    if (request.runtime.kind === 'bun') {
      command = resolvedBunExecutable(lookup)
      path = workerPathWithBun(command, SYSTEM_PATH)
      const cacheDir = join(lookup.root, 'cache', 'bun-user')
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
      chmodSync(cacheDir, 0o700)
      forced.BUN_INSTALL_CACHE_DIR = cacheDir
    }
    const variables = localHostVariables(baseEnv, path, request.env, forced)
    const assignments = Object.keys(variables)
      .sort()
      .map((name) => `${name}=${variables[name]}`)
    return {
      type: 'stdio',
      command: '/usr/bin/env',
      args: [
        '-i',
        ...assignments,
        command,
        ...(request.runtime.kind === 'bun' ? [request.command] : []),
        ...request.args
      ],
      env: {},
      ...(request.cwd ? { cwd: request.cwd } : {}),
      phiOrigin: 'user-stdio',
      phiUser
    }
  }
  const entry = managedStdioServer({
    ...lookup,
    ref: request.runtime.ref,
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    userEnv: request.env
  }).entry
  return {
    ...entry,
    phiOrigin: 'user-stdio',
    phiUser
  }
}

function resolvedBunExecutable(
  lookup: Pick<LocalStdioEntryLookup, 'resolveBunExecutable'>
): string {
  try {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const bun = (lookup.resolveBunExecutable ?? (() => resolveBunExecutable({ resourcesPath })))()
    if (!isAbsolute(bun)) throw new Error('Bun path must be absolute')
    return bun
  } catch {
    throw new Error('找不到内置 Bun')
  }
}

function localHostVariables(
  baseEnv: NodeJS.ProcessEnv,
  path: string,
  userEnv: Record<string, string>,
  forced: Record<string, string>
): Record<string, string> {
  const sanitized = Object.fromEntries(
    Object.entries(sanitizeHostEnvironment(baseEnv)).filter((entry): entry is [string, string] =>
      validHostValue(entry[1])
    )
  )
  const username = validHostValue(sanitized.USER) ? sanitized.USER : userInfo().username
  const lang =
    validHostValue(sanitized.LANG) && /utf-?8/iu.test(sanitized.LANG)
      ? sanitized.LANG
      : process.platform === 'darwin'
        ? 'en_US.UTF-8'
        : 'C.UTF-8'
  return {
    ...sanitized,
    PATH: path,
    HOME: validHostValue(sanitized.HOME) ? sanitized.HOME : homedir(),
    LANG: lang,
    TMPDIR: validHostValue(sanitized.TMPDIR) ? sanitized.TMPDIR : tmpdir(),
    USER: username,
    LOGNAME: validHostValue(sanitized.LOGNAME) ? sanitized.LOGNAME : username,
    ...forced,
    ...userEnv
  }
}

function validHostValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\0\r\n]/u.test(value)
}

export function validateLocalConnectorRequest(
  raw: unknown,
  options: LocalConnectorValidationOptions = {}
): LocalMcpConnectorRequest {
  if (!isRecord(raw)) throw new Error('本地连接器设置无效')
  rejectUnknownKeys(raw, new Set(['name', 'runtime', 'command', 'args', 'env', 'cwd', 'hint']))
  const name = validateName(raw.name as string)
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const catalogIds = options.catalogIds ?? []
  const reservedIds = new Set(
    [...API_KEY_CONNECTOR_IDS, ...catalogIds].map((id) => id.toLocaleLowerCase())
  )
  if (reservedIds.has(name.toLocaleLowerCase())) {
    throw new Error(`连接器名称 ${name} 与连接器目录冲突`)
  }
  const fileSystem = options.fileSystem ?? localConnectorFileSystem
  const servers = fileSystem.readConfig(agentDir).mcpServers ?? {}
  if (servers[name] !== undefined) throw new Error(`已有名为 ${name} 的 MCP 配置`)
  const runtime = validateRuntime(raw.runtime)
  const command = validateCommand(raw.command, runtime, fileSystem)
  const args = validateArgs(raw.args)
  const env = validateEnv(raw.env)
  const cwd = validateCwd(raw.cwd, fileSystem)
  const hint = validateHint(raw.hint)
  return { name, runtime, command, args, env, ...(cwd ? { cwd } : {}), ...(hint ? { hint } : {}) }
}

function validateHint(value: unknown): LocalMcpConnectorRequest['hint'] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('设置提示必须是对象')
  rejectUnknownKeys(value, new Set(['readmeUrl', 'setupCommands']))

  let readmeUrl: string | undefined
  if (value.readmeUrl !== undefined) {
    if (typeof value.readmeUrl !== 'string' || value.readmeUrl.length > 500) {
      throw new Error('README 提示链接无效')
    }
    try {
      const url = new URL(value.readmeUrl)
      if (
        url.protocol !== 'https:' ||
        url.hostname.toLowerCase() !== 'github.com' ||
        url.port ||
        url.username ||
        url.password ||
        url.pathname === '/'
      ) {
        throw new Error('invalid URL')
      }
    } catch {
      throw new Error('README 提示链接必须是无凭据的 GitHub HTTPS 链接')
    }
    readmeUrl = value.readmeUrl
  }

  let setupCommands: string[] | undefined
  if (value.setupCommands !== undefined) {
    if (!Array.isArray(value.setupCommands) || value.setupCommands.length > 3) {
      throw new Error('设置提示命令不能超过 3 条')
    }
    if (
      !value.setupCommands.every(
        (command) =>
          typeof command === 'string' &&
          command.length > 0 &&
          command.length <= 200 &&
          !/[\0\r\n]/u.test(command)
      )
    ) {
      throw new Error('设置提示命令必须是长度不超过 200 的单行字符串')
    }
    setupCommands = [...value.setupCommands]
  }

  return {
    ...(readmeUrl ? { readmeUrl } : {}),
    ...(setupCommands ? { setupCommands } : {})
  }
}

function validateRuntime(value: unknown): LocalMcpRuntime {
  if (
    !isRecord(value) ||
    (value.kind !== 'environment' && value.kind !== 'host' && value.kind !== 'bun')
  ) {
    throw new Error('运行位置无效')
  }
  if (value.kind === 'host' || value.kind === 'bun') {
    rejectUnknownKeys(value, new Set(['kind']))
    return { kind: value.kind }
  }
  rejectUnknownKeys(value, new Set(['kind', 'ref']))
  if (typeof value.ref !== 'string' || !ENVIRONMENT_REF.test(value.ref)) {
    throw new Error('Phi 运行环境引用无效')
  }
  return { kind: 'environment', ref: value.ref }
}

function validateCommand(
  value: unknown,
  runtime: LocalMcpRuntime,
  fileSystem: LocalConnectorFileSystem
): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) {
    throw new Error('命令不能为空，且不能包含换行或空字符')
  }
  const command = value.trim()
  if (runtime.kind === 'bun') {
    if (command !== 'x' && command !== 'run') {
      throw new Error('Phi 内置 Bun 命令只能是 x 或 run')
    }
    return command
  }
  if (runtime.kind === 'environment') {
    if (!ENVIRONMENT_COMMAND.test(command)) throw new Error('环境命令必须是不含路径的命令名')
    return command
  }
  if (!isAbsolute(command)) throw new Error('本机命令必须使用绝对路径')
  try {
    // Validate the target, but launch the path the user gave: venv interpreters and similar
    // symlinks locate their environment from argv[0], so resolving them would break the server.
    const resolved = fileSystem.realpath(command)
    if (!fileSystem.stat(resolved).isFile()) throw new Error('not a file')
    fileSystem.access(resolved, constants.X_OK)
  } catch {
    throw new Error('本机命令不存在、不是可执行文件或符号链接无效')
  }
  return command
}

function validateArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) {
    throw new Error(`参数必须是字符串数组，且不能超过 ${MAX_ARGUMENTS} 个`)
  }
  if (
    !value.every(
      (argument) =>
        typeof argument === 'string' &&
        argument.length <= MAX_VALUE_LENGTH &&
        !argument.includes('\0')
    )
  ) {
    throw new Error(`每个参数必须是不超过 ${MAX_VALUE_LENGTH} 个字符且不含空字符的字符串`)
  }
  return [...value]
}

function validateEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error('环境变量必须是对象')
  const entries = Object.entries(value)
  if (entries.length > 32) throw new Error('环境变量不能超过 32 个')
  const env: Record<string, string> = {}
  for (const [name, entry] of entries) {
    if (!ENVIRONMENT_NAME.test(name)) throw new Error(`环境变量名称无效: ${name}`)
    if (reservedEnvironmentName(name)) throw new Error(`不能设置保留的环境变量: ${name}`)
    if (typeof entry !== 'string' || entry.length > MAX_VALUE_LENGTH || /[\0\r\n]/u.test(entry)) {
      throw new Error(`环境变量 ${name} 的值无效`)
    }
    env[name] = entry
  }
  return env
}

function validateCwd(value: unknown, fileSystem: LocalConnectorFileSystem): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('工作目录必须是绝对路径')
  try {
    if (!fileSystem.stat(value).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error('工作目录不存在或不是目录')
  }
  return value
}

function reservedEnvironmentName(name: string): boolean {
  return (
    name === 'PATH' ||
    name === 'HOME' ||
    name === 'LANG' ||
    name === 'TMPDIR' ||
    name.startsWith('PHI_') ||
    name.startsWith('LD_') ||
    name.startsWith('DYLD_') ||
    name === 'PYTHONPATH' ||
    name === 'PYTHONHOME' ||
    name === 'NODE_OPTIONS' ||
    name === 'NODE_PATH' ||
    name.startsWith('BUN_') ||
    name.startsWith('CONDA_') ||
    name.startsWith('R_LIBS') ||
    name === 'JAVA_TOOL_OPTIONS' ||
    name === 'BASH_ENV' ||
    name === 'ENV' ||
    name === 'IFS'
  )
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('本地连接器包含未知字段')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
