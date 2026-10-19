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

import { isRecord } from '../../../shared/guards'
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
      runtimes.push({ ref: 'bun', label: 'Phi bundled Bun', kind: 'bun' })
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
    throw new Error('Only Connectors added as local stdio can be removed')
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
      throw new Error('The runtime is not ready. Build it in Environments first.')
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
    throw new Error(`MCP configuration ${request.name} already exists`)
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
    if (overridden)
      throw new Error(`Local stdio environment variables cannot override ${overridden}`)
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
    throw new Error('Bundled Bun was not found')
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
  if (!isRecord(raw)) throw new Error('Invalid local Connector settings')
  rejectUnknownKeys(raw, new Set(['name', 'runtime', 'command', 'args', 'env', 'cwd', 'hint']))
  const name = validateName(raw.name as string)
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const catalogIds = options.catalogIds ?? []
  const reservedIds = new Set(
    [...API_KEY_CONNECTOR_IDS, ...catalogIds].map((id) => id.toLocaleLowerCase())
  )
  if (reservedIds.has(name.toLocaleLowerCase())) {
    throw new Error(`Connector name ${name} conflicts with the Connector catalog`)
  }
  const fileSystem = options.fileSystem ?? localConnectorFileSystem
  const servers = fileSystem.readConfig(agentDir).mcpServers ?? {}
  if (servers[name] !== undefined) throw new Error(`MCP configuration ${name} already exists`)
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
  if (!isRecord(value)) throw new Error('Setup hints must be an object')
  rejectUnknownKeys(value, new Set(['readmeUrl', 'setupCommands']))

  let readmeUrl: string | undefined
  if (value.readmeUrl !== undefined) {
    if (typeof value.readmeUrl !== 'string' || value.readmeUrl.length > 500) {
      throw new Error('Invalid README hint URL')
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
      throw new Error('README hint URLs must use GitHub HTTPS without credentials')
    }
    readmeUrl = value.readmeUrl
  }

  let setupCommands: string[] | undefined
  if (value.setupCommands !== undefined) {
    if (!Array.isArray(value.setupCommands) || value.setupCommands.length > 3) {
      throw new Error('Use at most 3 setup hint commands')
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
      throw new Error('Setup hint commands must be single-line strings of at most 200 characters')
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
    throw new Error('Invalid runtime location')
  }
  if (value.kind === 'host' || value.kind === 'bun') {
    rejectUnknownKeys(value, new Set(['kind']))
    return { kind: value.kind }
  }
  rejectUnknownKeys(value, new Set(['kind', 'ref']))
  if (typeof value.ref !== 'string' || !ENVIRONMENT_REF.test(value.ref)) {
    throw new Error('Invalid Phi runtime reference')
  }
  return { kind: 'environment', ref: value.ref }
}

function validateCommand(
  value: unknown,
  runtime: LocalMcpRuntime,
  fileSystem: LocalConnectorFileSystem
): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) {
    throw new Error('Commands must not be empty or contain newlines or NUL')
  }
  const command = value.trim()
  if (runtime.kind === 'bun') {
    if (command !== 'x' && command !== 'run') {
      throw new Error('Phi bundled Bun commands must be x or run')
    }
    return command
  }
  if (runtime.kind === 'environment') {
    if (!ENVIRONMENT_COMMAND.test(command))
      throw new Error('Environment commands must be command names without a path')
    return command
  }
  if (!isAbsolute(command)) throw new Error('Host commands must use an absolute path')
  try {
    // Validate the target, but launch the path the user gave: venv interpreters and similar
    // symlinks locate their environment from argv[0], so resolving them would break the server.
    const resolved = fileSystem.realpath(command)
    if (!fileSystem.stat(resolved).isFile()) throw new Error('not a file')
    fileSystem.access(resolved, constants.X_OK)
  } catch {
    throw new Error(
      'The host command does not exist, is not executable, or has an invalid symbolic link'
    )
  }
  return command
}

function validateArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) {
    throw new Error(`Arguments must be a string array with at most ${MAX_ARGUMENTS} items`)
  }
  if (
    !value.every(
      (argument) =>
        typeof argument === 'string' &&
        argument.length <= MAX_VALUE_LENGTH &&
        !argument.includes('\0')
    )
  ) {
    throw new Error(
      `Each argument must be a string of at most ${MAX_VALUE_LENGTH} characters without NUL`
    )
  }
  return [...value]
}

function validateEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error('Environment variables must be an object')
  const entries = Object.entries(value)
  if (entries.length > 32) throw new Error('Use at most 32 environment variables')
  const env: Record<string, string> = {}
  for (const [name, entry] of entries) {
    if (!ENVIRONMENT_NAME.test(name)) throw new Error(`Invalid environment variable name: ${name}`)
    if (reservedEnvironmentName(name))
      throw new Error(`Cannot set reserved environment variable: ${name}`)
    if (typeof entry !== 'string' || entry.length > MAX_VALUE_LENGTH || /[\0\r\n]/u.test(entry)) {
      throw new Error(`Invalid value for environment variable ${name}`)
    }
    env[name] = entry
  }
  return env
}

function validateCwd(value: unknown, fileSystem: LocalConnectorFileSystem): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !isAbsolute(value))
    throw new Error('Working directory must use an absolute path')
  try {
    if (!fileSystem.stat(value).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error('Working directory does not exist or is not a directory')
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
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error('Local Connector settings contain unknown fields')
}
