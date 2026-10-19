import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import { remoteWorkspaceUri } from '../../../shared/remoteWorkspacePath'
import type {
  RemoteProjectMcpConfirmationItem,
  RemoteProjectMcpRuntimeServer,
  RemoteProjectMcpServerSummary
} from '../../../shared/remoteProjectMcpTypes'
import {
  resolveAuthorizedRemoteConnectionConfig,
  resolveRemoteWorkspaceHostBinding,
  type AuthorizedRemoteConnectionConfig,
  type RemoteWorkspaceHostBinding
} from '../remote-workspace-boundary'
import { SshHost } from '../workspace-host/ssh-host'
import type { WorkspaceHost } from '../workspace-host/types'
import { SSH_OPTIONS, shellQuote, validateHostAlias } from '../wrappers/remote-ssh-session'
import { buildSshConnectionArgs } from '../workspace-host/ssh-port-forward'
import {
  remoteProjectMcpTrustState,
  revokeRemoteProjectMcpIdentity,
  trustRemoteProjectMcpIdentity
} from './remote-project-mcp-trust-store'

import { isRecord } from '../../../shared/guards'
import { errorMessage } from '../../../shared/errorCodes'
const CONFIG_PATHS = ['.phi/mcp.json', '.mcp.json', '.omp/mcp.json', '.pi/mcp.json'] as const
const MAX_CONFIG_BYTES = 256 * 1024
const MAX_CONFIG_DIRECTORY_ENTRIES = 10_000

export interface RemoteProjectMcpContext {
  sessionId: string
  projectId: string
  cwd: string
  agentDir: string
}

export interface RemoteProjectMcpCatalog {
  summaries: RemoteProjectMcpServerSummary[]
  runtimeServers: RemoteProjectMcpRuntimeServer[]
}

export interface RemoteProjectMcpTrustMutation {
  relativePath: string
  contentHash: string
  confirmedItemIds: string[]
}

export interface RemoteProjectMcpServiceDependencies {
  resolveBinding?: (input: { sessionId: string; projectId: string }) => RemoteWorkspaceHostBinding
  resolveConnection?: (input: {
    sessionId: string
    projectId: string
  }) => AuthorizedRemoteConnectionConfig
  createHost?: (binding: RemoteWorkspaceHostBinding) => WorkspaceHost
}

type ParsedServer = {
  name: string
  entry: Record<string, unknown>
  command?: string
  args?: string[]
  envKeys?: string[]
  url?: string
  transport?: string
}

type LoadedConfig = {
  relativePath: string
  contentHash: string
  servers: ParsedServer[]
  items: RemoteProjectMcpConfirmationItem[]
  error?: string
}

const REMOTE_ENV_NAMES = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE'
] as const

function missing(error: unknown): boolean {
  return (
    (isRecord(error) && error.code === 'ENOENT') ||
    (error instanceof Error && /does not exist|目标不存在/u.test(error.message))
  )
}

function serverMap(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  if (isRecord(value.mcpServers)) return value.mcpServers
  if (isRecord(value.mcp_servers)) return value.mcp_servers
  return Object.values(value).some(
    (entry) =>
      isRecord(entry) && (typeof entry.command === 'string' || typeof entry.url === 'string')
  )
    ? value
    : undefined
}

function checkedServer(name: string, value: unknown): ParsedServer {
  if (
    !name ||
    name === '__proto__' ||
    name === 'prototype' ||
    name === 'constructor' ||
    Buffer.byteLength(name, 'utf8') > 128 ||
    /[\0\r\n]/u.test(name) ||
    !isRecord(value)
  ) {
    throw new Error(`Invalid MCP server name: ${name || '(empty)'}`)
  }
  const enabled = value.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new Error(`${name}: enabled must be a boolean`)
  }
  if (typeof value.command === 'string') {
    if (!value.command || value.command.includes('\0'))
      throw new Error(`${name}: invalid stdio command`)
    if (
      value.args !== undefined &&
      (!Array.isArray(value.args) ||
        value.args.length > 256 ||
        !value.args.every((argument) => typeof argument === 'string' && !argument.includes('\0')))
    ) {
      throw new Error(`${name}: stdio arguments must be a string array`)
    }
    if (
      value.env !== undefined &&
      (!isRecord(value.env) ||
        Object.keys(value.env).length > 128 ||
        !Object.entries(value.env).every(
          ([key, entry]) =>
            /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) &&
            typeof entry === 'string' &&
            !entry.includes('\0')
        ))
    ) {
      throw new Error(`${name}: invalid stdio environment variables`)
    }
    const args = Array.isArray(value.args) ? (value.args as string[]) : undefined
    const envKeys = isRecord(value.env) ? Object.keys(value.env).sort() : undefined
    return {
      name,
      entry: value,
      command: value.command,
      ...(args?.length ? { args: [...args] } : {}),
      ...(envKeys?.length ? { envKeys } : {}),
      transport: 'stdio'
    }
  }
  if (typeof value.url === 'string') {
    let url: URL
    try {
      url = new URL(value.url)
    } catch {
      throw new Error(`${name}: invalid MCP URL`)
    }
    if (url.protocol !== 'https:')
      throw new Error(`${name}: remote project MCP URLs must use HTTPS`)
    if (value.type !== undefined && value.type !== 'http' && value.type !== 'sse') {
      throw new Error(`${name}: invalid MCP transport`)
    }
    return {
      name,
      entry: value,
      url: value.url,
      transport: value.type === 'sse' ? 'sse' : 'http'
    }
  }
  throw new Error(`${name}: MCP configuration must provide an HTTPS URL or stdio command`)
}

function confirmationId(...parts: Array<string | number>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`
}

function confirmationItems(servers: readonly ParsedServer[]): RemoteProjectMcpConfirmationItem[] {
  const items: RemoteProjectMcpConfirmationItem[] = []
  for (const server of servers) {
    if (server.command) {
      items.push(
        {
          id: confirmationId(server.name, 'command'),
          serverName: server.name,
          kind: 'stdio-command',
          value: server.command
        },
        ...(server.args ?? []).map((argument, index): RemoteProjectMcpConfirmationItem => ({
          id: confirmationId(server.name, 'arg', index),
          serverName: server.name,
          kind: 'stdio-arg',
          value: argument,
          index
        })),
        ...(server.envKeys ?? []).map((key): RemoteProjectMcpConfirmationItem => ({
          id: confirmationId(server.name, 'env', key),
          serverName: server.name,
          kind: 'stdio-env',
          value: key
        }))
      )
      continue
    }
    if (server.url) {
      items.push({
        id: confirmationId(server.name, 'url'),
        serverName: server.name,
        kind: 'https-url',
        value: server.url
      })
    }
  }
  return items
}

async function readConfig(
  host: WorkspaceHost,
  relativePath: string
): Promise<{ content: Buffer; servers: ParsedServer[]; error?: string } | undefined> {
  let stat
  try {
    stat = await host.fs.stat(relativePath)
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  if (stat.kind !== 'file') throw new Error(`${relativePath} is not a regular file`)
  const directory = posix.dirname(relativePath)
  const basename = posix.basename(relativePath)
  let cursor: string | undefined
  let visited = 0
  let declaredKind: string | undefined
  do {
    const page = await host.fs.list(directory, {
      limit: Math.min(1000, MAX_CONFIG_DIRECTORY_ENTRIES - visited),
      ...(cursor ? { cursor } : {})
    })
    visited += page.entries.length
    declaredKind = page.entries.find((entry) => entry.name === basename)?.kind
    if (declaredKind) break
    cursor = page.nextCursor
    if (cursor && visited >= MAX_CONFIG_DIRECTORY_ENTRIES) {
      throw new Error(`The directory containing ${relativePath} exceeds the safe scan limit`)
    }
  } while (cursor)
  if (declaredKind !== 'file') {
    throw new Error(
      `${relativePath} must be a regular file inside the project, not a symbolic link`
    )
  }
  if (stat.size > MAX_CONFIG_BYTES) throw new Error(`${relativePath} exceeds the 256 KiB limit`)
  const read = await host.fs.readRange(relativePath, { offset: 0, length: MAX_CONFIG_BYTES + 1 })
  if (!read.eof || read.bytesRead > MAX_CONFIG_BYTES) {
    throw new Error(`${relativePath} exceeds the 256 KiB limit`)
  }
  const content = Buffer.from(read.content)
  if (content.includes(0)) throw new Error(`${relativePath} is not a text file`)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw new Error(`${relativePath} is not valid UTF-8 text`)
  }
  try {
    const parsed: unknown = JSON.parse(text)
    const map = serverMap(parsed)
    if (!map) throw new Error(`${relativePath} contains no MCP server configuration`)
    const servers = Object.entries(map)
      .map(([name, entry]) => checkedServer(name, entry))
      .sort((left, right) => left.name.localeCompare(right.name))
    return { content, servers }
  } catch (error) {
    return {
      content,
      servers: [],
      error:
        error instanceof SyntaxError
          ? `${relativePath} is not valid JSON`
          : error instanceof Error
            ? error.message
            : String(error)
    }
  }
}

function sourceUri(binding: RemoteWorkspaceHostBinding, relativePath: string): string {
  return remoteWorkspaceUri(binding.hostAlias, posix.join(binding.canonicalRoot, relativePath))
}

function trustIdentity(
  binding: RemoteWorkspaceHostBinding,
  config: Pick<LoadedConfig, 'relativePath' | 'contentHash'>
): {
  hostAlias: string
  projectRoot: string
  relativePath: string
  contentHash: string
} {
  return {
    hostAlias: binding.hostAlias,
    projectRoot: binding.canonicalRoot,
    relativePath: config.relativePath,
    contentHash: config.contentHash
  }
}

function remoteCommand(binding: RemoteWorkspaceHostBinding, server: ParsedServer): string {
  const entryEnv = isRecord(server.entry.env) ? (server.entry.env as Record<string, string>) : {}
  const inherited = REMOTE_ENV_NAMES.map(
    (name) => `${name}="\${${name}:-${name === 'PATH' ? '/usr/local/bin:/usr/bin:/bin' : ''}}"`
  )
  const configured = Object.entries(entryEnv).map(([name, value]) => shellQuote(`${name}=${value}`))
  const invocation = [server.command!, ...(server.args ?? [])].map(shellQuote).join(' ')
  const body = [
    `cd -P -- ${shellQuote(binding.remoteRoot)} || exit 72`,
    `[ "$PWD" = ${shellQuote(binding.canonicalRoot)} ] || exit 72`,
    `exec /usr/bin/env -i ${[...inherited, ...configured].join(' ')} ${invocation}`
  ].join('\n')
  return `bash -c ${shellQuote(body)}`
}

function runtimeConfig(
  context: RemoteProjectMcpContext,
  binding: RemoteWorkspaceHostBinding,
  connection: AuthorizedRemoteConnectionConfig,
  server: ParsedServer
): Record<string, unknown> {
  if (!server.command) {
    return {
      ...server.entry,
      type: server.transport,
      url: server.url,
      enabled: true
    }
  }
  return {
    type: 'stdio',
    command: 'ssh',
    args: [
      '-T',
      ...buildSshConnectionArgs(connection.connection),
      ...SSH_OPTIONS,
      '-o',
      'SendEnv=-*',
      '-o',
      'PermitLocalCommand=no',
      '-o',
      'RequestTTY=no',
      validateHostAlias(connection.hostAlias),
      remoteCommand(binding, server)
    ],
    cwd: context.agentDir,
    enabled: true,
    ...(typeof server.entry.timeout === 'number' ? { timeout: server.entry.timeout } : {}),
    ...(server.entry.requestIdFormat === 'number' || server.entry.requestIdFormat === 'string'
      ? { requestIdFormat: server.entry.requestIdFormat }
      : {})
  }
}

async function scan(
  context: RemoteProjectMcpContext,
  dependencies: RemoteProjectMcpServiceDependencies
): Promise<{
  binding: RemoteWorkspaceHostBinding
  connection: AuthorizedRemoteConnectionConfig
  configs: LoadedConfig[]
}> {
  // The boundary rejects any key besides sessionId/projectId, so never forward the whole context.
  const identity = { sessionId: context.sessionId, projectId: context.projectId }
  const binding = (
    dependencies.resolveBinding ??
    ((input) => resolveRemoteWorkspaceHostBinding(input, { agentDir: context.agentDir }))
  )(identity)
  const connection = (
    dependencies.resolveConnection ??
    ((input) => resolveAuthorizedRemoteConnectionConfig(input, { agentDir: context.agentDir }))
  )(identity)
  if (
    binding.sessionId !== connection.sessionId ||
    binding.projectId !== connection.projectId ||
    binding.hostAlias !== connection.hostAlias
  ) {
    throw new Error('The remote project MCP workspace does not match the SSH connection')
  }
  const host = dependencies.createHost?.(binding) ?? new SshHost(binding.config)
  try {
    const configs: LoadedConfig[] = []
    for (const relativePath of CONFIG_PATHS) {
      let config
      try {
        config = await readConfig(host, relativePath)
      } catch (error) {
        configs.push({
          relativePath,
          contentHash: createHash('sha256').update(`invalid:${relativePath}`).digest('hex'),
          servers: [],
          items: [],
          error: errorMessage(error)
        })
        continue
      }
      if (!config) continue
      const contentHash = createHash('sha256').update(config.content).digest('hex')
      configs.push({
        relativePath,
        contentHash,
        servers: config.servers,
        items: confirmationItems(config.servers),
        ...(config.error ? { error: config.error } : {})
      })
    }
    return { binding, connection, configs }
  } finally {
    await host.close?.().catch(() => undefined)
  }
}

export async function loadRemoteProjectMcpCatalog(
  context: RemoteProjectMcpContext,
  dependencies: RemoteProjectMcpServiceDependencies = {}
): Promise<RemoteProjectMcpCatalog> {
  const { binding, connection, configs } = await scan(context, dependencies)
  const summaries: RemoteProjectMcpServerSummary[] = []
  const runtimeServers: RemoteProjectMcpRuntimeServer[] = []
  const runtimeNames = new Set<string>()
  for (const config of configs) {
    const path = sourceUri(binding, config.relativePath)
    if (config.error) {
      summaries.push({
        id: `${path}:invalid`,
        name: config.relativePath,
        sourcePath: path,
        enabled: false,
        status: 'configured',
        trustState: 'invalid',
        available: false,
        diagnostics: [config.error],
        relativePath: config.relativePath,
        contentHash: config.contentHash,
        remoteProjectCwd: context.cwd,
        confirmationItems: []
      })
      continue
    }
    const trustState = remoteProjectMcpTrustState(trustIdentity(binding, config), context.agentDir)
    for (const server of config.servers) {
      const configuredEnabled = server.entry.enabled !== false
      const available = trustState === 'trusted' && configuredEnabled
      summaries.push({
        id: `${path}:${server.name}`,
        name: server.name,
        ...(server.command ? { command: server.command } : {}),
        ...(server.args ? { args: server.args } : {}),
        ...(server.envKeys ? { envKeys: server.envKeys } : {}),
        ...(server.url ? { url: server.url } : {}),
        ...(server.transport ? { transport: server.transport } : {}),
        sourcePath: path,
        enabled: available,
        status: 'configured',
        trustState,
        available,
        diagnostics:
          trustState === 'pending'
            ? [
                'Server project configuration is untrusted. MCP will not start or be exposed until trusted.'
              ]
            : trustState === 'changed'
              ? [
                  'Server project configuration changed. MCP will not start or be exposed until trusted again.'
                ]
              : configuredEnabled
                ? []
                : ['Server project configuration is disabled'],
        relativePath: config.relativePath,
        contentHash: config.contentHash,
        remoteProjectCwd: context.cwd,
        confirmationItems: config.items
      })
      if (available && !runtimeNames.has(server.name)) {
        runtimeNames.add(server.name)
        runtimeServers.push({
          name: server.name,
          sourcePath: path,
          config: runtimeConfig(context, binding, connection, server)
        })
      }
    }
  }
  return { summaries, runtimeServers }
}

function sameItems(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== new Set(actual).size) return false
  const left = [...actual].sort()
  const right = [...expected].sort()
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export async function trustRemoteProjectMcp(
  context: RemoteProjectMcpContext,
  mutation: RemoteProjectMcpTrustMutation,
  dependencies: RemoteProjectMcpServiceDependencies = {}
): Promise<void> {
  const { binding, configs } = await scan(context, dependencies)
  const config = configs.find((entry) => entry.relativePath === mutation.relativePath)
  if (!config || config.error || config.contentHash !== mutation.contentHash) {
    throw new Error(
      'Server project MCP configuration changed or is unavailable. Refresh and try again.'
    )
  }
  if (
    !sameItems(
      mutation.confirmedItemIds,
      config.items.map((item) => item.id)
    )
  ) {
    throw new Error(
      'Confirm every complete command, argument, environment variable name or HTTPS URL'
    )
  }
  trustRemoteProjectMcpIdentity(trustIdentity(binding, config), context.agentDir)
}

export async function revokeRemoteProjectMcpTrust(
  context: RemoteProjectMcpContext,
  mutation: Pick<RemoteProjectMcpTrustMutation, 'relativePath' | 'contentHash'>,
  dependencies: RemoteProjectMcpServiceDependencies = {}
): Promise<void> {
  const { binding, configs } = await scan(context, dependencies)
  const config = configs.find((entry) => entry.relativePath === mutation.relativePath)
  if (!config || config.error || config.contentHash !== mutation.contentHash) {
    throw new Error(
      'Server project MCP configuration changed or is unavailable. Refresh and try again.'
    )
  }
  revokeRemoteProjectMcpIdentity(trustIdentity(binding, config), context.agentDir)
}
