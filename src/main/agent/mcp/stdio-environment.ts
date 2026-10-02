import { isAbsolute, relative, resolve } from 'node:path'

import { describeEnvironment, readyEnvironment } from '../content/environment-refs'
import type { PhiPlatform } from '../envs/contract'
import { environmentVariables, resolveCommand, type EnvHandle } from '../envs/execution'
import { applyOverrides } from '../envs/project-environments'

/**
 * MCP stdio servers started inside a managed environment (execution contract,
 * `environmentVariables`). Mechanism only: nothing here reads or writes `mcp.json`.
 *
 * omp's native `mcp.json` loader copies only the fields it knows (`command`, `args`, `env`,
 * `cwd`, `type`, `enabled`, `timeout`, ...) and ignores the rest, so the marker lives in a
 * top-level `phiManaged` field of the entry. Entries without a valid marker are the user's.
 */
export const MANAGED_MARKER_FIELD = 'phiManaged'
const MARKER_VERSION = 1
const ENV_EXECUTABLE = '/usr/bin/env'

export interface ManagedStdioMarker {
  version: typeof MARKER_VERSION
  /** The reference as requested, before project overrides. */
  ref: string
  /** The reference actually used (after `applyOverrides`). */
  effectiveRef: string
  envId: string
  /** The command as requested. The entry runs it through `/usr/bin/env -i` (see buildEntry). */
  command: string
  /** The server's own arguments, without the `env -i` prefix. */
  args: string[]
  projectDir?: string
  /** Installed MCP package context for package-local environments, commands, and arguments. */
  packageId?: string
  packageDir?: string
  /** A pending entry is disabled until its environment becomes ready and refresh succeeds. */
  pending?: true
  desiredEnabled?: boolean
}

export interface ManagedStdioEntry {
  type: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  enabled?: boolean
  phiManaged: ManagedStdioMarker
}

export interface ManagedEnvironmentRequest {
  ref: string
  projectDir?: string
  pluginId?: string
  packageId?: string
  packageDir?: string
}

export interface ResolvedManagedEnvironment {
  /** Effective reference after overrides. */
  ref: string
  handle: EnvHandle
  warnings: string[]
}

/** Returns the ready environment for a request, or throws (e.g. `EnvironmentNotReadyError`). */
export type ManagedEnvironmentResolver = (
  request: ManagedEnvironmentRequest
) => ResolvedManagedEnvironment

export interface EnvironmentLookup {
  /** Runtime root that holds `envs/<envId>`. */
  root: string
  environmentsDir?: string
  agentDir?: string
  platform?: PhiPlatform
}

export interface ManagedStdioServerOptions extends EnvironmentLookup {
  ref: string
  command: string
  args?: readonly string[]
  cwd?: string
  projectDir?: string
  packageId?: string
  packageDir?: string
  desiredEnabled?: boolean
  /** Host environment to sanitize. Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv
}

export interface ManagedStdioServer {
  entry: ManagedStdioEntry
  warnings: string[]
}

export class McpCommandNotFoundError extends Error {
  readonly envId: string
  readonly command: string

  constructor(envId: string, command: string) {
    super(`command not found in environment ${envId}: ${command}`)
    this.name = 'McpCommandNotFoundError'
    this.envId = envId
    this.command = command
  }
}

export interface RefreshFailure {
  name: string
  ref: string
  error: Error
}

export interface RefreshResult<T extends McpConfigLike> {
  config: T
  /** Names of managed entries that were regenerated. */
  refreshed: string[]
  /** Managed entries that could not be regenerated; they are returned unchanged. */
  failures: RefreshFailure[]
}

export type McpConfigLike = Record<string, unknown> & { mcpServers?: Record<string, unknown> }

interface EntrySpec {
  ref: string
  command: string
  args: readonly string[]
  cwd?: string
  projectDir?: string
  packageId?: string
  packageDir?: string
  desiredEnabled?: boolean
}

/** `applyOverrides` (with a project), then `describeEnvironment` and `readyEnvironment`. */
export function resolveManagedEnvironment(
  request: ManagedEnvironmentRequest,
  lookup: EnvironmentLookup
): ResolvedManagedEnvironment {
  const overridden = request.projectDir
    ? applyOverrides(request.ref, request.projectDir)
    : { ref: request.ref, warnings: [] }
  const descriptor = describeEnvironment(overridden.ref, {
    environmentsDir: lookup.environmentsDir,
    agentDir: lookup.agentDir,
    pluginId: request.pluginId,
    ...(request.packageId && request.packageDir
      ? { mcpPackage: { id: request.packageId, dir: request.packageDir } }
      : {}),
    platform: lookup.platform,
    projectDir: request.projectDir
  })
  const handle = readyEnvironment(lookup.root, descriptor)
  return { ref: overridden.ref, handle, warnings: overridden.warnings }
}

/**
 * The `mcp.json` stdio entry for `command` inside the environment `ref`. A missing or
 * unfinished environment throws `EnvironmentNotReadyError`; nothing is built and the host
 * is never used instead.
 */
export function managedStdioServer(options: ManagedStdioServerOptions): ManagedStdioServer {
  const spec = validateSpec(options)
  const resolved = resolveManagedEnvironment(
    {
      ref: spec.ref,
      projectDir: spec.projectDir,
      packageId: spec.packageId,
      packageDir: spec.packageDir
    },
    options
  )
  return {
    entry: buildEntry(spec, resolved, options.baseEnv),
    warnings: resolved.warnings
  }
}

/**
 * A disabled managed entry retained while its environment is absent. Refresh replaces it with
 * the isolated `env -i` invocation as soon as the environment is ready.
 */
export function pendingManagedStdioServer(
  options: ManagedStdioServerOptions,
  pending: { ref: string; envId: string }
): ManagedStdioServer {
  const spec = validateSpec(options)
  const marker = markerFor(spec, pending.ref, pending.envId, true)
  const entry: ManagedStdioEntry = {
    type: 'stdio',
    command: ENV_EXECUTABLE,
    args: ['-i', '/usr/bin/false'],
    env: {},
    enabled: false,
    phiManaged: marker
  }
  if (spec.cwd !== undefined) entry.cwd = spec.cwd
  return { entry, warnings: [] }
}

export function readManagedMarker(entry: unknown): ManagedStdioMarker | undefined {
  if (!isRecord(entry)) return undefined
  const marker = entry[MANAGED_MARKER_FIELD]
  if (!isRecord(marker) || marker.version !== MARKER_VERSION) return undefined
  const {
    ref,
    effectiveRef,
    envId,
    command,
    args,
    projectDir,
    packageId,
    packageDir,
    pending,
    desiredEnabled
  } = marker
  if (!isNonEmptyString(ref) || !isNonEmptyString(effectiveRef)) return undefined
  if (!isNonEmptyString(envId) || !isNonEmptyString(command)) return undefined
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return undefined
  if (projectDir !== undefined && !isNonEmptyString(projectDir)) return undefined
  if ((packageId === undefined) !== (packageDir === undefined)) return undefined
  if (
    packageId !== undefined &&
    (typeof packageId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(packageId))
  ) {
    return undefined
  }
  if (packageDir !== undefined && !isAbsolutePath(packageDir)) return undefined
  if (pending !== undefined && pending !== true) return undefined
  if (desiredEnabled !== undefined && typeof desiredEnabled !== 'boolean') return undefined
  const result: ManagedStdioMarker = {
    version: MARKER_VERSION,
    ref,
    effectiveRef,
    envId,
    command,
    args: [...args]
  }
  if (projectDir !== undefined) result.projectDir = projectDir
  if (packageId !== undefined && packageDir !== undefined) {
    result.packageId = packageId
    result.packageDir = packageDir
  }
  if (pending === true) result.pending = true
  if (desiredEnabled !== undefined) result.desiredEnabled = desiredEnabled
  return result
}

/**
 * Regenerate every Phi-managed stdio entry whose environment now resolves to a different
 * envId (or a different effective reference). Entries without a marker are returned as the
 * same objects. The caller reads and writes `mcp.json`.
 */
export function refreshManagedStdioServers<T extends McpConfigLike>(
  config: T,
  resolve: ManagedEnvironmentResolver,
  options: { baseEnv?: NodeJS.ProcessEnv } = {}
): RefreshResult<T> {
  const servers = config.mcpServers
  if (!isRecord(servers)) return { config: { ...config }, refreshed: [], failures: [] }
  const refreshed: string[] = []
  const failures: RefreshFailure[] = []
  const next: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(servers)) {
    const marker = readManagedMarker(entry)
    if (!marker || !isRecord(entry)) {
      next[name] = entry
      continue
    }
    try {
      const regenerated = refreshEntry(entry, marker, resolve, options.baseEnv)
      next[name] = regenerated ?? entry
      if (regenerated) refreshed.push(name)
    } catch (error) {
      next[name] = entry
      failures.push({ name, ref: marker.ref, error: asError(error) })
    }
  }
  return { config: { ...config, mcpServers: next }, refreshed, failures }
}

function refreshEntry(
  entry: Record<string, unknown>,
  marker: ManagedStdioMarker,
  resolve: ManagedEnvironmentResolver,
  baseEnv: NodeJS.ProcessEnv | undefined
): Record<string, unknown> | undefined {
  const resolved = resolve({
    ref: marker.ref,
    projectDir: marker.projectDir,
    packageId: marker.packageId,
    packageDir: marker.packageDir
  })
  if (
    marker.pending !== true &&
    resolved.handle.envId === marker.envId &&
    resolved.ref === marker.effectiveRef
  ) {
    return undefined
  }
  const desiredEnabled =
    marker.pending === true
      ? (marker.desiredEnabled ?? true)
      : typeof entry.enabled === 'boolean'
        ? entry.enabled
        : marker.desiredEnabled
  const spec: EntrySpec = {
    ref: marker.ref,
    command: marker.command,
    args: marker.args,
    cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
    projectDir: marker.projectDir,
    packageId: marker.packageId,
    packageDir: marker.packageDir,
    desiredEnabled
  }
  // Keep the user's own settings on the entry (enabled, timeout, ...); replace ours.
  const regenerated = { ...entry, ...buildEntry(spec, resolved, baseEnv) }
  if (desiredEnabled !== undefined) regenerated.enabled = desiredEnabled
  return regenerated
}

/**
 * omp spawns stdio servers with `{ ...process.env, ...entry.env }` and drops empty values, so
 * `env` alone cannot remove host variables (PYTHONPATH, CONDA_*, LD_*, ...). The entry
 * therefore runs `/usr/bin/env -i K=V … <command> <args>`: the server sees exactly the
 * execution contract's variables. `env` stays empty; omp expands `$VAR` in args, which the
 * contract's values (paths, `1`, `Agg`, `/dev/null`) never contain.
 */
function buildEntry(
  spec: EntrySpec,
  resolved: ResolvedManagedEnvironment,
  baseEnv: NodeJS.ProcessEnv | undefined
): ManagedStdioEntry {
  const { handle } = resolved
  const variables = environmentVariables(handle, { baseEnv })
  const command = spec.command.startsWith('./')
    ? resolvePackageCommand(spec.command, spec.packageDir)
    : resolveCommand(spec.command, variables.PATH ?? '')
  if (!command) throw new McpCommandNotFoundError(handle.envId, spec.command)
  const marker = markerFor(spec, resolved.ref, handle.envId, false)
  const assignments = Object.keys(variables)
    .sort()
    .map((name) => `${name}=${variables[name]}`)
  const entry: ManagedStdioEntry = {
    type: 'stdio',
    command: ENV_EXECUTABLE,
    args: ['-i', ...assignments, command, ...expandedArgs(spec.args, spec.packageDir)],
    env: {},
    phiManaged: marker
  }
  if (spec.cwd !== undefined) entry.cwd = spec.cwd
  if (spec.desiredEnabled !== undefined) entry.enabled = spec.desiredEnabled
  return entry
}

function validateSpec(options: ManagedStdioServerOptions): EntrySpec {
  if (!isNonEmptyString(options.ref)) throw new Error('MCP stdio server needs an environment ref')
  if (!isNonEmptyString(options.command)) throw new Error('MCP stdio server needs a command')
  const args = options.args ?? []
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new Error('MCP stdio server args must be strings')
  }
  if (options.cwd !== undefined && !isAbsolutePath(options.cwd)) {
    throw new Error(`MCP stdio server cwd must be an absolute path: ${String(options.cwd)}`)
  }
  if (options.projectDir !== undefined && !isAbsolutePath(options.projectDir)) {
    throw new Error(`project directory must be an absolute path: ${String(options.projectDir)}`)
  }
  if ((options.packageId === undefined) !== (options.packageDir === undefined)) {
    throw new Error('MCP package id and directory must be provided together')
  }
  if (options.packageId !== undefined && !/^[a-z][a-z0-9-]{1,63}$/.test(options.packageId)) {
    throw new Error(`invalid MCP package id: ${options.packageId}`)
  }
  if (options.packageDir !== undefined && !isAbsolutePath(options.packageDir)) {
    throw new Error(`MCP package directory must be an absolute path: ${options.packageDir}`)
  }
  if (options.command.startsWith('./') && options.packageDir === undefined) {
    throw new Error('a package-relative MCP command requires a package directory')
  }
  if (!isNonEmptyString(options.root)) throw new Error('runtime root is required')
  const spec: EntrySpec = { ref: options.ref, command: options.command, args }
  if (options.cwd !== undefined) spec.cwd = options.cwd
  if (options.projectDir !== undefined) spec.projectDir = options.projectDir
  if (options.packageId !== undefined && options.packageDir !== undefined) {
    spec.packageId = options.packageId
    spec.packageDir = options.packageDir
  }
  if (options.desiredEnabled !== undefined) spec.desiredEnabled = options.desiredEnabled
  return spec
}

function markerFor(
  spec: EntrySpec,
  effectiveRef: string,
  envId: string,
  pending: boolean
): ManagedStdioMarker {
  const marker: ManagedStdioMarker = {
    version: MARKER_VERSION,
    ref: spec.ref,
    effectiveRef,
    envId,
    command: spec.command,
    args: [...spec.args]
  }
  if (spec.projectDir !== undefined) marker.projectDir = spec.projectDir
  if (spec.packageId !== undefined && spec.packageDir !== undefined) {
    marker.packageId = spec.packageId
    marker.packageDir = spec.packageDir
    marker.desiredEnabled = spec.desiredEnabled ?? true
  }
  if (pending) marker.pending = true
  return marker
}

function expandedArgs(args: readonly string[], packageDir: string | undefined): string[] {
  return args.map((arg) => {
    if (!arg.includes('${package}')) return arg
    if (!packageDir) throw new Error('${package} requires an MCP package directory')
    return arg.replaceAll('${package}', packageDir)
  })
}

function resolvePackageCommand(
  command: string,
  packageDir: string | undefined
): string | undefined {
  if (!packageDir) return undefined
  const candidate = resolve(packageDir, command.slice(2))
  const within = relative(packageDir, candidate)
  if (!within || within.startsWith('..') || isAbsolute(within)) return undefined
  return resolveCommand(candidate, '')
}

function isAbsolutePath(value: unknown): value is string {
  return isNonEmptyString(value) && isAbsolute(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
