import { isAbsolute, resolve } from 'node:path'

import type { RemoteProjectMcpRuntimeServer } from '../../../shared/remoteProjectMcpTypes'
import type { McpSnapshotLike, RemoteMcpProfilePolicy } from './remote-mcp-policy'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '__proto__' &&
    value !== 'prototype' &&
    value !== 'constructor' &&
    Buffer.byteLength(value, 'utf8') <= 128 &&
    !/[\0\r\n]/u.test(value)
  )
}

function remoteSource(value: unknown): { sourcePath: string; hostAlias: string } | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined
  const match = /^ssh:\/\/([A-Za-z0-9][A-Za-z0-9._@-]*)(\/[^?#]*)$/u.exec(value)
  if (!match) return undefined
  try {
    const segments = match[2]!.split('/').map((segment) => decodeURIComponent(segment))
    if (
      segments.some(
        (segment) =>
          segment.includes('/') || segment.includes('\0') || segment === '.' || segment === '..'
      )
    ) {
      return undefined
    }
    const path = segments.join('/')
    if (
      !/(?:^|\/)\.(?:phi|omp|pi)\/mcp\.json$/u.test(path) &&
      !/(?:^|\/)\.mcp\.json$/u.test(path)
    ) {
      return undefined
    }
    return { sourcePath: value, hostAlias: match[1]! }
  } catch {
    return undefined
  }
}

const SAFE_SSH_TAIL = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ClearAllForwardings=yes',
  '-o',
  'ServerAliveInterval=10',
  '-o',
  'ServerAliveCountMax=3',
  '-o',
  'SendEnv=-*',
  '-o',
  'PermitLocalCommand=no',
  '-o',
  'RequestTTY=no'
] as const
const STDIO_CONFIG_KEYS = new Set([
  'type',
  'command',
  'args',
  'cwd',
  'enabled',
  'timeout',
  'requestIdFormat'
])

function validStdioConfig(
  value: Record<string, unknown>,
  agentDir: string,
  hostAlias: string
): boolean {
  if (
    Object.keys(value).some((key) => !STDIO_CONFIG_KEYS.has(key)) ||
    value.type !== 'stdio' ||
    value.command !== 'ssh' ||
    value.enabled !== true ||
    typeof value.cwd !== 'string' ||
    resolve(value.cwd) !== resolve(agentDir) ||
    !Array.isArray(value.args) ||
    value.args.length < 4 ||
    value.args.length > 512 ||
    !value.args.every((argument) => typeof argument === 'string' && !argument.includes('\0'))
  ) {
    return false
  }
  if (
    (value.timeout !== undefined &&
      (typeof value.timeout !== 'number' ||
        !Number.isFinite(value.timeout) ||
        value.timeout < 0)) ||
    (value.requestIdFormat !== undefined &&
      value.requestIdFormat !== 'number' &&
      value.requestIdFormat !== 'string')
  ) {
    return false
  }
  const args = value.args as string[]
  let cursor = 1
  if (args[cursor] === '-l') {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._@-]{0,127}$/u.test(args[cursor + 1] ?? '')) return false
    cursor += 2
  }
  if (args[cursor] === '-p') {
    const port = Number(args[cursor + 1])
    if (!/^[0-9]+$/u.test(args[cursor + 1] ?? '') || port < 1 || port > 65535) return false
    cursor += 2
  }
  if (args[cursor] === '-i') {
    const identityFile = args[cursor + 1]
    if (
      !identityFile ||
      !isAbsolute(identityFile) ||
      /[\0\r\n]/u.test(identityFile) ||
      args[cursor + 2] !== '-o' ||
      args[cursor + 3] !== 'IdentitiesOnly=yes'
    ) {
      return false
    }
    cursor += 4
  }
  for (const expected of SAFE_SSH_TAIL) {
    if (args[cursor] !== expected) return false
    cursor += 1
  }
  if (args[cursor] !== hostAlias || cursor + 2 !== args.length) return false
  const remoteCommand = args.at(-1)
  return (
    args[0] === '-T' &&
    typeof remoteCommand === 'string' &&
    remoteCommand.startsWith("bash -c '") &&
    remoteCommand.endsWith("'") &&
    remoteCommand.includes('cd -P -- ') &&
    remoteCommand.includes('[ "$PWD" = ') &&
    remoteCommand.includes('exec /usr/bin/env -i ')
  )
}

function safeStdioConfig(value: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'stdio',
    command: 'ssh',
    args: [...(value.args as string[])],
    cwd: value.cwd,
    enabled: true,
    ...(typeof value.timeout === 'number' ? { timeout: value.timeout } : {}),
    ...(value.requestIdFormat === 'number' || value.requestIdFormat === 'string'
      ? { requestIdFormat: value.requestIdFormat }
      : {})
  }
}

function validHttpConfig(value: Record<string, unknown>): boolean {
  if ((value.type !== 'http' && value.type !== 'sse') || typeof value.url !== 'string') {
    return false
  }
  try {
    return new URL(value.url).protocol === 'https:'
  } catch {
    return false
  }
}

export function remoteProjectMcpRuntimeServersValue(
  value: unknown,
  agentDir: string
): RemoteProjectMcpRuntimeServer[] {
  if (!Array.isArray(value) || value.length > 256) return []
  const names = new Set<string>()
  const servers: RemoteProjectMcpRuntimeServer[] = []
  for (const candidate of value) {
    const source = isRecord(candidate) ? remoteSource(candidate.sourcePath) : undefined
    if (
      !isRecord(candidate) ||
      !validName(candidate.name) ||
      names.has(candidate.name) ||
      !source ||
      !isRecord(candidate.config) ||
      (!validStdioConfig(candidate.config, agentDir, source.hostAlias) &&
        !validHttpConfig(candidate.config))
    ) {
      continue
    }
    names.add(candidate.name)
    const config =
      candidate.config.type === 'stdio'
        ? safeStdioConfig(candidate.config)
        : { ...candidate.config }
    servers.push({
      name: candidate.name,
      sourcePath: source.sourcePath,
      config
    })
  }
  return servers
}

export function mergeRemoteProjectMcpSnapshot(
  snapshot: McpSnapshotLike,
  policy: RemoteMcpProfilePolicy,
  projectServers: readonly RemoteProjectMcpRuntimeServer[]
): { snapshot: McpSnapshotLike; policy: RemoteMcpProfilePolicy } {
  if (projectServers.length === 0) return { snapshot, policy }
  const configs = { ...snapshot.configs }
  const sources = { ...snapshot.sources }
  const allowed = new Set(policy.allowedServerNames)
  const blocked = new Map(policy.blockedServerReasons)
  const prepared = new Map(policy.preparedEntries)
  for (const server of projectServers) {
    configs[server.name] = { ...server.config }
    sources[server.name] = { path: server.sourcePath, level: 'project' }
    allowed.add(server.name)
    blocked.delete(server.name)
    prepared.set(server.name, { ...server.config })
  }
  return {
    snapshot: { ...snapshot, configs, sources },
    policy: {
      allowedServerNames: allowed,
      blockedServerReasons: blocked,
      preparedEntries: prepared
    }
  }
}

export function remoteProjectMcpPolicy(
  projectServers: readonly RemoteProjectMcpRuntimeServer[]
): RemoteMcpProfilePolicy | undefined {
  if (projectServers.length === 0) return undefined
  return {
    allowedServerNames: new Set(projectServers.map((server) => server.name)),
    blockedServerReasons: new Map(),
    preparedEntries: new Map(projectServers.map((server) => [server.name, { ...server.config }]))
  }
}

export function mergeRemoteMcpPolicies(
  application: RemoteMcpProfilePolicy,
  project: RemoteMcpProfilePolicy | undefined
): RemoteMcpProfilePolicy {
  if (!project) return application
  const allowed = new Set(application.allowedServerNames)
  const blocked = new Map(application.blockedServerReasons)
  const prepared = new Map(application.preparedEntries)
  for (const name of project.allowedServerNames) {
    allowed.add(name)
    blocked.delete(name)
    const entry = project.preparedEntries.get(name)
    if (entry) prepared.set(name, entry)
  }
  return {
    allowedServerNames: allowed,
    blockedServerReasons: blocked,
    preparedEntries: prepared
  }
}
