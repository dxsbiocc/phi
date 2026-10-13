import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { connectToServer, disconnectServer, listTools } from '@oh-my-pi/pi-coding-agent/mcp/client'
import type { MCPServerConnection, MCPStdioServerConfig } from '@oh-my-pi/pi-coding-agent/mcp/types'

import { PHI_PLATFORMS } from '../envs/platform'
import { acquireEnvironmentLease, type EnvironmentLease } from '../envs/leases'
import {
  managedStdioServer,
  readManagedMarker,
  type EnvironmentLookup
} from '../mcp/stdio-environment'
import { OwnedStdioTransportScope } from './owned-stdio-transports'
import { ConfiguredStdioProbeError } from './configured-stdio-probe-error'
import {
  ConfiguredStdioRequestRegistry,
  type ConfiguredStdioTimeoutRange,
  configuredStdioRequestKey,
  configuredStdioTimeoutMessage,
  resolveConfiguredStdioTimeoutMs
} from './configured-stdio-request-control'

export interface ConfiguredStdioMcpToolsRequest {
  name: string
  /** Main-process verified installed/configured entry; never renderer-provided launch fields. */
  entry: unknown
  environment: EnvironmentLookup
  timeoutMs?: number
  requestKey?: string
  captureStderr?: boolean
}

export interface ConfiguredStdioMcpToolsDependencies {
  clock?: {
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
    clearTimeout(timer: ReturnType<typeof setTimeout>): void
  }
  /** Test/smoke-only direct-call bounds; the worker never supplies this override. */
  timeoutRange?: ConfiguredStdioTimeoutRange
}

const discoveryClock: NonNullable<ConfiguredStdioMcpToolsDependencies['clock']> = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer)
}

const activeDiscoveries = new ConfiguredStdioRequestRegistry()
const STDERR_TAIL_BYTES = 4096
const STDERR_SHELL_SCRIPT = 'log=$1; shift; exec "$@" 2>>"$log"'

export function cancelConfiguredStdioMcpTools(request: unknown): boolean {
  if (!isRecord(request)) throw new Error('Invalid MCP discovery cancellation request')
  const requestKey = configuredStdioRequestKey(request.requestKey)
  if (!requestKey) throw new Error('Invalid MCP discovery requestKey')
  return activeDiscoveries.cancel(requestKey)
}

/** One-shot discovery only: no installation, configuration writes, or persistent connection. */
export async function listConfiguredStdioMcpTools(
  request: unknown,
  deps: ConfiguredStdioMcpToolsDependencies = {}
): Promise<string[]> {
  if (!isRecord(request) || typeof request.name !== 'string' || !request.name.trim()) {
    throw new Error('MCP stdio discovery requires a configured server name')
  }
  const entry = request.entry
  const name = request.name
  const timeoutMs = resolveConfiguredStdioTimeoutMs(request.timeoutMs, deps.timeoutRange)
  const requestKey = configuredStdioRequestKey(request.requestKey)
  if (request.captureStderr !== undefined && typeof request.captureStderr !== 'boolean') {
    throw new Error('Invalid MCP stderr capture flag')
  }
  const captureStderr = request.captureStderr === true
  if (
    !isRecord(entry) ||
    (entry.type !== undefined && entry.type !== 'stdio') ||
    entry.url !== undefined ||
    typeof entry.command !== 'string' ||
    !entry.command.trim() ||
    (entry.args !== undefined &&
      (!Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === 'string')))
  ) {
    throw new Error('MCP tool discovery requires a configured stdio server')
  }
  const marker = readManagedMarker(entry)
  const userEntry = !marker && isUserStdioEntry(entry)
  if (!marker && !userEntry) {
    throw new Error('MCP tool discovery requires valid Phi-managed environment metadata')
  }
  if (marker?.pending)
    throw new Error('MCP environment is not ready; build it before discovering tools')
  if (entry.cwd !== undefined && (typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd))) {
    throw new Error('MCP stdio server cwd must be an absolute path')
  }
  if (
    entry.timeout !== undefined &&
    (typeof entry.timeout !== 'number' || !Number.isFinite(entry.timeout) || entry.timeout < 0)
  ) {
    throw new Error('Invalid MCP stdio request timeout')
  }

  const requestEnvironment =
    marker || captureStderr ? environmentLookup(request.environment) : undefined
  let environment: EnvironmentLookup | undefined
  let managedEnvId: string | undefined
  let launch: Pick<MCPStdioServerConfig, 'command' | 'args' | 'env' | 'cwd'>
  if (marker) {
    // Regenerate even when envId is unchanged: cached invocation/env data must never override
    // the current managed environment's command resolution and sanitization contract.
    environment = requestEnvironment!
    const managed = managedStdioServer({
      ...environment,
      ref: marker.ref,
      command: marker.command,
      args: marker.args,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
      projectDir: marker.projectDir,
      packageId: marker.packageId,
      packageDir: marker.packageDir,
      userEnv: configuredUserEnvironment(entry, marker.ref)
    }).entry
    managedEnvId = managed.phiManaged.envId
    launch = {
      command: managed.command,
      args: managed.args,
      env: managed.env,
      cwd: managed.cwd
    }
  } else {
    launch = {
      command: entry.command,
      args: Array.isArray(entry.args) ? [...entry.args] : [],
      env: {},
      cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined
    }
  }
  if (requestKey && activeDiscoveries.has(requestKey)) {
    throw new Error('MCP discovery request is already active')
  }
  const stderrCapture = captureStderr
    ? createStderrCapture(requestEnvironment!.root, launch)
    : undefined
  if (stderrCapture) launch = stderrCapture.launch
  const config: MCPStdioServerConfig = {
    type: 'stdio',
    ...launch,
    timeout:
      typeof entry.timeout === 'number' && entry.timeout > 0
        ? Math.min(entry.timeout, timeoutMs)
        : timeoutMs,
    ...(entry.requestIdFormat === 'number' || entry.requestIdFormat === 'string'
      ? { requestIdFormat: entry.requestIdFormat }
      : {})
  }
  const transports = new OwnedStdioTransportScope()
  const controller = new AbortController()
  activeDiscoveries.register(requestKey, controller)
  const clock = deps.clock ?? discoveryClock
  const timer = clock.setTimeout(
    () => controller.abort(new Error(configuredStdioTimeoutMessage(timeoutMs))),
    timeoutMs
  )
  let connection: MCPServerConnection | undefined
  let lease: EnvironmentLease | undefined
  let failed = false
  let failure: unknown
  let tools: string[] = []
  let stderrDetail: string | undefined
  try {
    if (environment && managedEnvId) {
      lease = await acquireEnvironmentLease({
        root: environment.root,
        envId: managedEnvId,
        signal: controller.signal
      })
    }
    connection = await transports.run(() =>
      connectToServer(name, config, { signal: controller.signal })
    )
    tools = (await listTools(connection, { signal: controller.signal })).map((tool) => tool.name)
  } catch (error) {
    failed = true
    failure =
      controller.signal.aborted && controller.signal.reason instanceof Error
        ? controller.signal.reason
        : error
  } finally {
    clock.clearTimeout(timer)
    try {
      if (connection) await disconnectServer(connection).catch(() => undefined)
    } finally {
      try {
        await transports.drain()
        lease?.release()
      } finally {
        try {
          activeDiscoveries.delete(requestKey, controller)
        } finally {
          if (stderrCapture) {
            stderrDetail = readStderrTail(stderrCapture.path)
            try {
              unlinkSync(stderrCapture.path)
            } catch {
              // The private capture file may already be absent after an external cleanup.
            }
          }
        }
      }
    }
  }
  if (failed) {
    if (!captureStderr) throw failure
    const source = failure instanceof Error ? failure : new Error(String(failure))
    const error = new ConfiguredStdioProbeError(source.message, stderrDetail)
    if (source.stack) error.stack = source.stack
    throw error
  }
  return tools
}

function createStderrCapture(
  runtimeRoot: string,
  launch: Pick<MCPStdioServerConfig, 'command' | 'args' | 'env' | 'cwd'>
): {
  path: string
  launch: Pick<MCPStdioServerConfig, 'command' | 'args' | 'env' | 'cwd'>
} {
  const directory = join(runtimeRoot, 'tmp', 'mcp-probe')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const path = join(directory, `${randomUUID()}.log`)
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    fchmodSync(fd, 0o600)
  } finally {
    closeSync(fd)
  }
  return {
    path,
    launch: {
      ...launch,
      command: '/bin/sh',
      args: ['-c', STDERR_SHELL_SCRIPT, 'sh', path, launch.command, ...(launch.args ?? [])]
    }
  }
}

function readStderrTail(path: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile()) return undefined
    const length = Math.min(stat.size, STDERR_TAIL_BYTES)
    const bytes = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const count = readSync(fd, bytes, offset, length - offset, stat.size - length + offset)
      if (!count) break
      offset += count
    }
    const detail = sanitizeStderrTail(bytes.subarray(0, offset).toString('utf8')).trim()
    return detail || undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function sanitizeStderrTail(value: string): string {
  const normalized = value.replace(/\r\n?/gu, '\n')
  let sanitized = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index)
    if (code === 27) {
      const kind = normalized.charCodeAt(index + 1)
      if (kind === 91) {
        index = skipAnsiCsi(normalized, index + 2)
      } else if (kind === 93) {
        index = skipAnsiOsc(normalized, index + 2)
      } else if (index + 1 < normalized.length) {
        index += 1
      }
      continue
    }
    if (code === 155) {
      index = skipAnsiCsi(normalized, index + 1)
      continue
    }
    if ((code <= 31 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)) continue
    sanitized += normalized[index]
  }
  return sanitized
}

function skipAnsiCsi(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 64 && code <= 126) return index
  }
  return value.length - 1
}

function skipAnsiOsc(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 7) return index
    if (code === 27 && value.charCodeAt(index + 1) === 92) return index + 1
  }
  return value.length - 1
}

function isUserStdioEntry(entry: Record<string, unknown>): boolean {
  if (
    entry.phiOrigin !== 'user-stdio' ||
    entry.phiManaged !== undefined ||
    entry.command !== '/usr/bin/env' ||
    !Array.isArray(entry.args) ||
    entry.args[0] !== '-i' ||
    !isRecord(entry.phiUser) ||
    !isRecord(entry.phiUser.runtime) ||
    (entry.phiUser.runtime.kind !== 'host' && entry.phiUser.runtime.kind !== 'bun') ||
    !validUserEnvironment(entry.phiUser.env)
  ) {
    return false
  }
  let commandIndex = 1
  while (/^[A-Z_][A-Z0-9_]*=/u.test(entry.args[commandIndex] ?? '')) commandIndex += 1
  const command = entry.args[commandIndex]
  if (typeof command !== 'string' || !isAbsolute(command)) return false
  if (entry.phiUser.runtime.kind === 'host') return true
  const subcommand = entry.args[commandIndex + 1]
  return subcommand === 'x' || subcommand === 'run'
}

function configuredUserEnvironment(
  entry: Record<string, unknown>,
  ref: string
): Record<string, string> | undefined {
  if (entry.phiOrigin !== 'user-stdio') return undefined
  const metadata = entry.phiUser
  if (
    !isRecord(metadata) ||
    !isRecord(metadata.runtime) ||
    metadata.runtime.kind !== 'environment' ||
    metadata.runtime.ref !== ref ||
    !validUserEnvironment(metadata.env)
  ) {
    throw new Error('MCP tool discovery requires valid user stdio metadata')
  }
  return { ...(metadata.env as Record<string, string>) }
}

function validUserEnvironment(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return (
    entries.length <= 32 &&
    entries.every(
      ([name, entry]) =>
        /^[A-Z_][A-Z0-9_]*$/u.test(name) &&
        ![
          'PATH',
          'HOME',
          'LANG',
          'TMPDIR',
          'PYTHONPATH',
          'PYTHONHOME',
          'NODE_OPTIONS',
          'NODE_PATH',
          'JAVA_TOOL_OPTIONS',
          'BASH_ENV',
          'ENV',
          'IFS'
        ].includes(name) &&
        !['PHI_', 'LD_', 'DYLD_', 'BUN_', 'CONDA_', 'R_LIBS'].some((prefix) =>
          name.startsWith(prefix)
        ) &&
        typeof entry === 'string' &&
        entry.length <= 4096 &&
        !/[\0\r\n]/u.test(entry)
    )
  )
}

function environmentLookup(value: unknown): EnvironmentLookup {
  if (!isRecord(value) || typeof value.root !== 'string' || !isAbsolute(value.root)) {
    throw new Error('MCP discovery requires the current managed runtime root')
  }
  const lookup: EnvironmentLookup = { root: value.root }
  for (const key of ['agentDir', 'environmentsDir'] as const) {
    const path = value[key]
    if (path === undefined) continue
    if (typeof path !== 'string' || !isAbsolute(path)) {
      throw new Error(`MCP discovery requires an absolute ${key}`)
    }
    lookup[key] = path
  }
  if (value.platform !== undefined) {
    const platform = PHI_PLATFORMS.find((platform) => platform === value.platform)
    if (!platform) throw new Error('Invalid MCP managed environment platform')
    lookup.platform = platform
  }
  return lookup
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
