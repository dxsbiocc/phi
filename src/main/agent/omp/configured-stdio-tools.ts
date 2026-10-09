import { isAbsolute } from 'node:path'
import { connectToServer, disconnectServer, listTools } from '@oh-my-pi/pi-coding-agent/mcp/client'
import type { MCPServerConnection, MCPStdioServerConfig } from '@oh-my-pi/pi-coding-agent/mcp/types'

import { PHI_PLATFORMS } from '../envs/platform'
import { acquireEnvironmentLease, type EnvironmentLease } from '../envs/leases'
import { managedStdioServer, readManagedMarker, type EnvironmentLookup } from '../mcp'
import { OwnedStdioTransportScope } from './owned-stdio-transports'

// A connector may populate its executable cache on first launch. Keep that startup bounded
// while allowing more time than the HTTP probe's short network handshake.
const DISCOVERY_TIMEOUT_MS = 90_000

export interface ConfiguredStdioMcpToolsRequest {
  name: string
  /** Main-process verified installed/configured entry; never renderer-provided launch fields. */
  entry: unknown
  environment: EnvironmentLookup
}

/** One-shot discovery only: no installation, configuration writes, or persistent connection. */
export async function listConfiguredStdioMcpTools(request: unknown): Promise<string[]> {
  if (!isRecord(request) || typeof request.name !== 'string' || !request.name.trim()) {
    throw new Error('MCP stdio discovery requires a configured server name')
  }
  const entry = request.entry
  const name = request.name
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
  if (!marker) throw new Error('MCP tool discovery requires valid Phi-managed environment metadata')
  if (marker.pending)
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

  // Regenerate even when envId is unchanged: cached invocation/env data must never override
  // the current managed environment's command resolution and sanitization contract.
  const environment = environmentLookup(request.environment)
  const managed = managedStdioServer({
    ...environment,
    ref: marker.ref,
    command: marker.command,
    args: marker.args,
    cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
    projectDir: marker.projectDir,
    packageId: marker.packageId,
    packageDir: marker.packageDir
  }).entry
  const config: MCPStdioServerConfig = {
    type: 'stdio',
    command: managed.command,
    args: managed.args,
    env: managed.env,
    cwd: managed.cwd,
    timeout:
      typeof entry.timeout === 'number' && entry.timeout > 0
        ? Math.min(entry.timeout, DISCOVERY_TIMEOUT_MS)
        : DISCOVERY_TIMEOUT_MS,
    ...(entry.requestIdFormat === 'number' || entry.requestIdFormat === 'string'
      ? { requestIdFormat: entry.requestIdFormat }
      : {})
  }
  const transports = new OwnedStdioTransportScope()
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('MCP tool discovery timed out after 90 seconds')),
    DISCOVERY_TIMEOUT_MS
  )
  let connection: MCPServerConnection | undefined
  let lease: EnvironmentLease | undefined
  try {
    lease = await acquireEnvironmentLease({
      root: environment.root,
      envId: managed.phiManaged.envId,
      signal: controller.signal
    })
    connection = await transports.run(() =>
      connectToServer(name, config, { signal: controller.signal })
    )
    return (await listTools(connection, { signal: controller.signal })).map((tool) => tool.name)
  } finally {
    clearTimeout(timer)
    try {
      if (connection) await disconnectServer(connection).catch(() => undefined)
    } finally {
      await transports.drain()
      lease?.release()
    }
  }
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
