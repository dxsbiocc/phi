import { isAbsolute } from 'node:path'

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
}

export interface ManagedStdioEntry {
  type: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  phiManaged: ManagedStdioMarker
}

export interface ManagedEnvironmentRequest {
  ref: string
  projectDir?: string
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
  pluginsDir?: string
  platform?: PhiPlatform
}

export interface ManagedStdioServerOptions extends EnvironmentLookup {
  ref: string
  command: string
  args?: readonly string[]
  cwd?: string
  projectDir?: string
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
    pluginsDir: lookup.pluginsDir,
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
    { ref: spec.ref, projectDir: spec.projectDir },
    options
  )
  return {
    entry: buildEntry(spec, resolved, options.baseEnv),
    warnings: resolved.warnings
  }
}

export function readManagedMarker(entry: unknown): ManagedStdioMarker | undefined {
  if (!isRecord(entry)) return undefined
  const marker = entry[MANAGED_MARKER_FIELD]
  if (!isRecord(marker) || marker.version !== MARKER_VERSION) return undefined
  const { ref, effectiveRef, envId, command, args, projectDir } = marker
  if (!isNonEmptyString(ref) || !isNonEmptyString(effectiveRef)) return undefined
  if (!isNonEmptyString(envId) || !isNonEmptyString(command)) return undefined
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return undefined
  if (projectDir !== undefined && !isNonEmptyString(projectDir)) return undefined
  const result: ManagedStdioMarker = {
    version: MARKER_VERSION,
    ref,
    effectiveRef,
    envId,
    command,
    args: [...args]
  }
  if (projectDir !== undefined) result.projectDir = projectDir
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
  const resolved = resolve({ ref: marker.ref, projectDir: marker.projectDir })
  if (resolved.handle.envId === marker.envId && resolved.ref === marker.effectiveRef) {
    return undefined
  }
  const spec: EntrySpec = {
    ref: marker.ref,
    command: marker.command,
    args: marker.args,
    cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
    projectDir: marker.projectDir
  }
  // Keep the user's own settings on the entry (enabled, timeout, ...); replace ours.
  return { ...entry, ...buildEntry(spec, resolved, baseEnv) }
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
  const command = resolveCommand(spec.command, variables.PATH ?? '')
  if (!command) throw new McpCommandNotFoundError(handle.envId, spec.command)
  const marker: ManagedStdioMarker = {
    version: MARKER_VERSION,
    ref: spec.ref,
    effectiveRef: resolved.ref,
    envId: handle.envId,
    command: spec.command,
    args: [...spec.args]
  }
  if (spec.projectDir !== undefined) marker.projectDir = spec.projectDir
  const assignments = Object.keys(variables)
    .sort()
    .map((name) => `${name}=${variables[name]}`)
  const entry: ManagedStdioEntry = {
    type: 'stdio',
    command: ENV_EXECUTABLE,
    args: ['-i', ...assignments, command, ...spec.args],
    env: {},
    phiManaged: marker
  }
  if (spec.cwd !== undefined) entry.cwd = spec.cwd
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
  if (!isNonEmptyString(options.root)) throw new Error('runtime root is required')
  const spec: EntrySpec = { ref: options.ref, command: options.command, args }
  if (options.cwd !== undefined) spec.cwd = options.cwd
  if (options.projectDir !== undefined) spec.projectDir = options.projectDir
  return spec
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
