import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { Settings } from '@oh-my-pi/pi-coding-agent'
import type { PhiToolResult } from '../types'
import type { DesktopMcpToolMetadata } from '../rpc/desktop-mcp-types'
import { rpcIdentifier, rpcToolCallId } from '../rpc/control-frame'
import { webSearchPath } from '../rpc/desktop-websearch-protocol'
import { remoteMcpInputUsesLocalProject } from '../phi-extension/lib/remote-mcp'
import { isMcpConnectorUserDisabled } from '../../mcp-connectors'
import {
  API_KEY_CONNECTOR_IDS,
  featuredApiKeyMcpConfig,
  isFeaturedMcpApiKeyInstalled
} from '../../mcp-key-credentials'
import { readMcpConfig } from '../../mcp/package-config'
import { remoteProjectMcpRuntimeServersValue } from '../../mcp/remote-project-mcp-runtime'
import { leasedProfileMcpManager, disconnectLeasedMcpManager } from './mcp-profile'
import { getContext } from './runtime-context'
import {
  isMcpServerBackedOff,
  mcpConfigFingerprint,
  recordMcpServerFailure,
  recordMcpServerSuccess
} from './mcp-failure-backoff'
import { isRecord } from './common'
import { requestHost, sendEvent } from './ipc'
import { writeAppLog } from '../../app-logger'
import {
  DesktopMcpStageError,
  type DesktopMcpSkipReason,
  type DesktopMcpStage
} from '../rpc/desktop-mcp-stages'

type OwnedManager = Awaited<ReturnType<typeof leasedProfileMcpManager>>
interface Call {
  controller: AbortController
  done: Promise<PhiToolResult>
}
interface Scope {
  id: string
  controller: AbortController
  agentDir: string
  resourceCwd: string
  serverNames: Set<string>
  entries: Map<string, string>
  catalog: Map<string, DesktopMcpToolMetadata>
  secrets: Set<string>
  calls: Map<string, Call>
  seen: Set<string>
  skipped: Map<string, DesktopMcpSkipReason>
  ready: Promise<void>
  settings?: Settings
  owned?: OwnedManager
  watcher?: FSWatcher
  close?: Promise<void>
}
const scopes = new Map<string, Scope>()
const failure = (): Error => new Error('Desktop MCP resource unavailable')
/** Records why one server was left out. Only a fixed reason code and the server name are logged. */
function logSkipped(sessionId: string, name: string, reason: DesktopMcpSkipReason): void {
  writeAppLog({
    level: 'warn',
    event: 'desktop_mcp_server_skipped',
    sessionId,
    metadata: { server: name, reason }
  })
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function remember(scope: Scope, value: unknown): void {
  if (typeof value === 'string' && value.trim()) {
    for (const text of [value, value.trim()]) {
      scope.secrets.add(text)
      scope.secrets.add(JSON.stringify(text).slice(1, -1))
      scope.secrets.add(encodeURIComponent(text))
    }
  }
}
function redact(scope: Scope, value: unknown, safeResultKeys = false): unknown {
  if (typeof value === 'string') {
    for (const secret of [...scope.secrets].sort((a, b) => b.length - a.length))
      value = (value as string).split(secret).join('[redacted]')
    return value
  }
  if (Array.isArray(value)) return value.map((item) => redact(scope, item, safeResultKeys))
  if (isRecord(value)) {
    const unsafe = new Set(safeResultKeys ? ['__proto__', 'constructor', 'prototype'] : [])
    const entries = Object.entries(value).map(([key, item]) => ({
      key,
      item,
      redactedKey: redact(scope, key) as string
    }))
    // Preserve ordinary names regardless of input order. Secret/unsafe names
    // receive distinct safe aliases so collisions cannot silently drop values.
    const reserved = new Set(
      entries
        .filter(({ key, redactedKey }) => key === redactedKey && !unsafe.has(key))
        .map(({ key }) => key)
    )
    const output: Record<string, unknown> = Object.create(null)
    for (const { key, item, redactedKey } of entries) {
      const base = unsafe.has(redactedKey) ? `[${redactedKey}]` : redactedKey
      let name = base
      if (base !== key) {
        let suffix = 2
        while (reserved.has(name) || Object.hasOwn(output, name)) name = `${base} (${suffix++})`
      }
      output[name] = redact(scope, item, safeResultKeys)
    }
    return output
  }
  return value
}
function credentialSecrets(scope: Scope, ctx: Awaited<ReturnType<typeof getContext>>): void {
  for (const { credential } of ctx.authStorage.credentials.list()) {
    if (credential.type === 'api_key') remember(scope, credential.key)
    else {
      remember(scope, credential.access)
      remember(scope, credential.refresh)
      if ('clientSecret' in credential) remember(scope, credential.clientSecret)
    }
  }
}
function assertCurrent(scope: Scope): void {
  if (scope.controller.signal.aborted || scopes.get(scope.id) !== scope) throw failure()
  const profile = readMcpConfig(scope.agentDir)
  for (const [name, digest] of scope.entries) {
    if (
      isMcpConnectorUserDisabled(name, scope.agentDir) ||
      fingerprint(profile.mcpServers?.[name]) !== digest
    )
      throw failure()
  }
}
function retire(scope: Scope): void {
  if (!scope.controller.signal.aborted) scope.controller.abort(failure())
  for (const call of scope.calls.values()) call.controller.abort(failure())
  void disconnectLeasedMcpManager(scope.owned?.manager, scope.owned?.transports).catch(() => {})
}
async function close(scope: Scope): Promise<void> {
  retire(scope)
  return (scope.close ??= (async () => {
    scope.watcher?.close()
    await scope.ready.catch(() => {})
    await Promise.allSettled([...scope.calls.values()].map((call) => call.done))
    try {
      await disconnectLeasedMcpManager(scope.owned?.manager, scope.owned?.transports)
    } finally {
      for (const lease of scope.owned?.leases.values() ?? []) lease.release()
      scope.settings?.cancelPendingSaves()
      if (scopes.get(scope.id) === scope) scopes.delete(scope.id)
      scope.catalog.clear()
    }
  })())
}
function toolMetadata(
  tool: ReturnType<OwnedManager['manager']['getTools']>[number]
): DesktopMcpToolMetadata {
  const value = {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>
  }
  return {
    ...value,
    signature: fingerprint({ ...value, server: tool.mcpServerName, tool: tool.mcpToolName })
  }
}
interface DesktopMcpCreated {
  tools: DesktopMcpToolMetadata[]
  skipped: Array<{ name: string; reason: DesktopMcpSkipReason }>
}
async function create(params: Record<string, unknown>): Promise<DesktopMcpCreated> {
  if (
    !rpcIdentifier(params.scopeId) ||
    !isRecord(params.identity) ||
    ![params.identity.runtimeSessionId, params.identity.sessionId, params.identity.projectId].every(
      rpcIdentifier
    ) ||
    !webSearchPath(params.identity.cwd) ||
    !webSearchPath(params.agentDir) ||
    !webSearchPath(params.resourceCwd) ||
    !Array.isArray(params.serverNames) ||
    params.serverNames.length > 256 ||
    !params.serverNames.every(rpcIdentifier) ||
    new Set(params.serverNames).size !== params.serverNames.length ||
    typeof params.allowStdio !== 'boolean' ||
    scopes.has(params.scopeId)
  )
    throw failure()
  const names = new Set(params.serverNames as string[])
  const sessionId = params.identity.sessionId as string
  let stage: DesktopMcpStage = 'profile'
  const skip = (name: string, reason: DesktopMcpSkipReason): void => {
    names.delete(name)
    scope.skipped.set(name, reason)
    logSkipped(sessionId, name, reason)
  }
  const scope: Scope = {
    id: params.scopeId,
    controller: new AbortController(),
    agentDir: params.agentDir,
    resourceCwd: params.resourceCwd,
    serverNames: names,
    entries: new Map(),
    catalog: new Map(),
    secrets: new Set(),
    calls: new Map(),
    seen: new Set(),
    skipped: new Map(),
    ready: Promise.resolve()
  }
  scopes.set(scope.id, scope)
  scope.ready = (async () => {
    const profile = readMcpConfig(scope.agentDir)
    const trustedProjectServers = remoteProjectMcpRuntimeServersValue(
      params.remoteProjectMcpServers,
      scope.agentDir
    )
    if (
      Array.isArray(params.remoteProjectMcpServers) &&
      trustedProjectServers.length !== params.remoteProjectMcpServers.length
    )
      throw failure()
    const projectServers = trustedProjectServers.filter((server) => names.has(server.name))
    stage = 'credentials'
    for (const [name, value] of Object.entries(process.env))
      if (/KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION/i.test(name)) remember(scope, value)
    for (const name of [...names]) {
      if (projectServers.some((server) => server.name === name)) continue
      if (profile.mcpServers?.[name] === undefined) skip(name, 'unavailable')
      else scope.entries.set(name, fingerprint(profile.mcpServers[name]))
    }
    assertCurrent(scope)
    scope.watcher = watch(scope.agentDir, { persistent: false }, () => {
      try {
        assertCurrent(scope)
      } catch {
        retire(scope)
      }
    })
    scope.watcher.on('error', () => retire(scope))
    const ctx = await getContext(scope.agentDir)
    assertCurrent(scope)
    scope.settings = await Settings.loadReadOnly({
      cwd: scope.resourceCwd,
      agentDir: scope.agentDir
    })
    scope.settings.stopWatching()
    credentialSecrets(scope, ctx)
    const overrides: OwnedManager['snapshot']['configs'] = {}
    const backoffFingerprint = (name: string): string =>
      mcpConfigFingerprint([
        scope.entries.get(name),
        projectServers.find((server) => server.name === name),
        overrides[name]
      ])
    for (const name of names) {
      if (!API_KEY_CONNECTOR_IDS.includes(name as (typeof API_KEY_CONNECTOR_IDS)[number])) continue
      if (!isFeaturedMcpApiKeyInstalled(name, scope.agentDir)) {
        skip(name, 'api_key_missing')
        continue
      }
      let key: unknown
      try {
        key = await requestHost('mcp.featuredApiKey', { id: name })
      } catch {
        assertCurrent(scope)
        skip(name, 'api_key_unavailable')
        continue
      }
      assertCurrent(scope)
      if (typeof key !== 'string' || !key) {
        skip(name, 'api_key_missing')
        continue
      }
      remember(scope, key)
      overrides[name] = featuredApiKeyMcpConfig(name, key)
    }
    // A server that just failed to start with this same config is not retried every run;
    // that retry costs the whole connect timeout before the model can start.
    for (const name of [...names]) {
      if (!isMcpServerBackedOff(scope.agentDir, name, backoffFingerprint(name))) continue
      skip(name, 'backoff')
    }
    stage = 'manager'
    scope.owned = await leasedProfileMcpManager(
      scope.agentDir,
      scope.resourceCwd,
      scope.settings,
      ctx.authStorage,
      scope.resourceCwd,
      projectServers,
      { serverNames: new Set(names), allowStdio: params.allowStdio === true, overrides }
    )
    assertCurrent(scope)
    const { manager, snapshot } = scope.owned
    for (const { name, reason } of scope.owned.skipped) skip(name, reason)
    stage = 'connect'
    const configs: typeof snapshot.configs = {}
    for (const [name, original] of Object.entries(snapshot.configs)) {
      let config: Awaited<ReturnType<typeof manager.prepareConfig>>
      try {
        config = await manager.prepareConfig(original)
      } catch {
        assertCurrent(scope)
        skip(name, 'prepare_failed')
        continue
      }
      assertCurrent(scope)
      if (config.type === 'http' || config.type === 'sse') {
        for (const value of Object.values(config.headers ?? {})) remember(scope, value)
        configs[name] = { ...config, headerPolicy: 'origin-locked' as const }
      } else {
        configs[name] = config
        for (const [key, value] of Object.entries(config.env ?? {}))
          if (/KEY|TOKEN|PASSWORD|SECRET|AUTH/i.test(key)) remember(scope, value)
      }
    }
    credentialSecrets(scope, ctx)
    const connected = await manager.connectServers(configs, snapshot.sources, undefined, 15000)
    const status = await manager.waitForStartup(15000)
    assertCurrent(scope)
    // A server that failed to connect, is still starting, or needs a login that has
    // lapsed only costs the conversation that server's tools.
    for (const name of [...names]) {
      if (connected.errors.has(name)) skip(name, 'connect_failed')
      else if (status.failed.some((failed) => failed.name === name)) skip(name, 'startup_failed')
      else if (status.pending.includes(name)) skip(name, 'startup_pending')
      else if (!manager.getConnection(name)) skip(name, 'not_connected')
      else {
        recordMcpServerSuccess(scope.agentDir, name)
        continue
      }
      if (scope.skipped.get(name) !== 'startup_pending')
        recordMcpServerFailure(scope.agentDir, name, backoffFingerprint(name))
      await manager.disconnectServer(name).catch(() => {})
    }
    stage = 'catalog'
    manager.addNotificationListener((serverName, method, raw) => {
      if (
        method !== 'notifications/progress' ||
        !isRecord(raw) ||
        typeof raw.progressToken !== 'string'
      )
        return
      const call = scope.calls.get(raw.progressToken)
      if (
        !call ||
        call.controller.signal.aborted ||
        scope.controller.signal.aborted ||
        !names.has(serverName)
      )
        return
      if (typeof raw.progress !== 'number' || !Number.isFinite(raw.progress) || raw.progress < 0)
        return
      const total =
        typeof raw.total === 'number' && Number.isFinite(raw.total) && raw.total >= raw.progress
          ? raw.total
          : undefined
      sendEvent(
        'desktopMcpProgress',
        {
          requestId: raw.progressToken,
          result: {
            content: [
              {
                type: 'text',
                text: `MCP progress: ${raw.progress}${total === undefined ? '' : `/${total}`}`
              }
            ],
            details: { progress: raw.progress, ...(total === undefined ? {} : { total }) }
          }
        },
        { sessionId: scope.id }
      )
    })
    for (const tool of manager.getTools()) {
      if (!names.has(tool.mcpServerName ?? '') || !tool.mcpToolName || scope.catalog.has(tool.name))
        throw failure()
      scope.catalog.set(tool.name, toolMetadata(tool))
    }
    credentialSecrets(scope, ctx)
  })()
  try {
    await scope.ready
    assertCurrent(scope)
    return {
      tools: [...scope.catalog.values()].map(
        (tool) => redact(scope, tool) as DesktopMcpToolMetadata
      ),
      skipped: [...scope.skipped].map(([name, reason]) => ({ name, reason }))
    }
  } catch {
    const cancelled = scope.controller.signal.aborted
    await close(scope)
    if (cancelled) throw failure()
    writeAppLog({
      level: 'error',
      event: 'desktop_mcp_discovery_failed',
      sessionId,
      metadata: { stage }
    })
    throw new DesktopMcpStageError(stage)
  }
}
function resultFor(scope: Scope, raw: unknown): PhiToolResult {
  if (!isRecord(raw) || !Array.isArray(raw.content)) throw failure()
  if (raw.isError === true)
    return {
      content: [{ type: 'text', text: 'MCP server reported a tool failure' }],
      isError: true
    }
  const content: PhiToolResult['content'] = []
  for (const item of raw.content) {
    if (!isRecord(item)) throw failure()
    if (item.type === 'text' && typeof item.text === 'string')
      content.push({ type: 'text', text: redact(scope, item.text) as string })
    else if (
      item.type === 'image' &&
      typeof item.data === 'string' &&
      typeof item.mimeType === 'string'
    )
      content.push({ type: 'image', data: item.data, mimeType: item.mimeType })
    else if (
      item.type === 'resource' &&
      isRecord(item.resource) &&
      typeof item.resource.uri === 'string'
    )
      content.push({
        type: 'text',
        text: redact(
          scope,
          `[Resource: ${item.resource.uri}]\n${typeof item.resource.text === 'string' ? item.resource.text : ''}`
        ) as string
      })
    else throw failure()
  }
  const structuredContent = isRecord(raw.structuredContent)
    ? redact(scope, raw.structuredContent, true)
    : undefined
  if (structuredContent)
    content.push({ type: 'text', text: JSON.stringify(structuredContent, null, 2) })
  return {
    content: content.length ? content : [{ type: 'text', text: '' }],
    ...(structuredContent ? { details: { structuredContent } } : {})
  }
}
async function call(scope: Scope, params: Record<string, unknown>): Promise<PhiToolResult> {
  assertCurrent(scope)
  if (
    !rpcIdentifier(params.requestId) ||
    !rpcToolCallId(params.toolCallId) ||
    typeof params.name !== 'string' ||
    typeof params.signature !== 'string' ||
    !isRecord(params.input) ||
    scope.calls.size >= 64 ||
    scope.seen.has(params.requestId)
  )
    throw failure()
  const metadata = scope.catalog.get(params.name)
  const manager = scope.owned?.manager
  const tool = manager?.getTools().find((tool) => tool.name === params.name)
  if (
    !metadata ||
    !manager ||
    !tool ||
    metadata.signature !== params.signature ||
    toolMetadata(tool).signature !== metadata.signature ||
    !tool.mcpServerName ||
    !tool.mcpToolName
  )
    throw failure()
  const connection = manager.getConnection(tool.mcpServerName)
  if (
    !connection ||
    remoteMcpInputUsesLocalProject(params.input, {
      agentDir: scope.agentDir,
      localProjectAnchor: scope.resourceCwd
    })
  )
    throw failure()
  const controller = new AbortController()
  const abort = (): void => controller.abort(failure())
  scope.controller.signal.addEventListener('abort', abort, { once: true })
  scope.seen.add(params.requestId)
  const operation = Promise.resolve()
    .then(async () => {
      assertCurrent(scope)
      controller.signal.throwIfAborted()
      // This manager/connection belongs only to this scope. Initial auth is
      // resolved normally, but a tool's 401/403 must never replay its effect.
      // Keep the hook disabled; restoring it after one concurrent call would
      // re-enable retries for another. New connections are checked on every call.
      if ('onAuthError' in connection.transport) connection.transport.onAuthError = undefined
      const raw = await connection.transport.request(
        'tools/call',
        {
          name: tool.mcpToolName,
          arguments: params.input,
          _meta: { progressToken: params.requestId }
        },
        { signal: controller.signal }
      )
      assertCurrent(scope)
      controller.signal.throwIfAborted()
      credentialSecrets(scope, await getContext(scope.agentDir))
      return resultFor(scope, raw)
    })
    .catch(() => {
      throw failure()
    })
    .finally(() => {
      scope.controller.signal.removeEventListener('abort', abort)
      scope.calls.delete(params.requestId as string)
    })
  scope.calls.set(params.requestId, { controller, done: operation })
  return operation
}
export async function handleDesktopMcpRequest(method: string, value: unknown): Promise<unknown> {
  try {
    if (!isRecord(value) || !rpcIdentifier(value.scopeId)) throw failure()
    if (method === 'mcp.desktopCreate') return await create(value)
    const scope = scopes.get(value.scopeId)
    if (!scope) {
      if (method === 'mcp.desktopClose' || method === 'mcp.desktopCancel') return undefined
      throw failure()
    }
    if (method === 'mcp.desktopClose') return await close(scope)
    if (method === 'mcp.desktopCancel') {
      if (value.requestId === undefined) retire(scope)
      else if (rpcIdentifier(value.requestId))
        scope.calls.get(value.requestId)?.controller.abort(failure())
      else throw failure()
      return undefined
    }
    if (method === 'mcp.desktopCall') return await call(scope, value)
    throw failure()
  } catch (error) {
    throw error instanceof DesktopMcpStageError ? error : failure()
  }
}
export async function closeAllDesktopMcpScopes(): Promise<void> {
  await Promise.all([...scopes.values()].map(close))
}
