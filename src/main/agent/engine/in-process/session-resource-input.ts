import type { PhiExtensionEnvironmentBinding } from '../phi-extension'
import type { MCPServerConfig } from '../mcp/omp-mcp'

import { isRecord } from './common'

export interface SessionContextFile {
  path: string
  content: string
}

export interface SessionMcpServer {
  name: string
  config: MCPServerConfig
}

export interface SessionEnvironmentInput {
  ref: string
  pluginId?: string
}

export interface SessionResourceSnapshot {
  personaMarkdown: string
  contextFiles?: SessionContextFile[]
  skills?: unknown[]
}

type HostRequest = (method: string, params: unknown) => Promise<unknown>

export function sessionContextFiles(value: unknown): SessionContextFile[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('contextFiles must be an array')
  return value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.path !== 'string' ||
      !candidate.path ||
      typeof candidate.content !== 'string'
    ) {
      throw new Error('contextFiles contains an invalid entry')
    }
    return { path: candidate.path, content: candidate.content }
  })
}

export function sessionMcpServers(value: unknown): SessionMcpServer[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('mcpServers must be an array')
  const names = new Set<string>()
  return value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== 'string' ||
      !candidate.name ||
      names.has(candidate.name) ||
      !mcpServerConfig(candidate.config)
    ) {
      throw new Error('mcpServers contains an invalid or duplicate entry')
    }
    names.add(candidate.name)
    return { name: candidate.name, config: structuredClone(candidate.config) }
  })
}

function optionalStringArray(value: unknown): boolean {
  return (
    value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  )
}

function optionalStringRecord(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && Object.values(value).every((item) => typeof item === 'string'))
  )
}

function commonMcpConfig(value: Record<string, unknown>): boolean {
  return (
    (value.enabled === undefined || typeof value.enabled === 'boolean') &&
    (value.timeout === undefined || typeof value.timeout === 'number') &&
    (value.requestIdFormat === undefined ||
      value.requestIdFormat === 'string' ||
      value.requestIdFormat === 'number')
  )
}

function remoteMcpConfig(value: Record<string, unknown>): boolean {
  return typeof value.url === 'string' && !!value.url && optionalStringRecord(value.headers)
}

function stdioMcpConfig(value: Record<string, unknown>): boolean {
  return (
    (value.type === undefined || value.type === 'stdio') &&
    typeof value.command === 'string' &&
    !!value.command &&
    optionalStringArray(value.args) &&
    optionalStringRecord(value.env) &&
    (value.cwd === undefined || typeof value.cwd === 'string')
  )
}

function mcpServerConfig(value: unknown): value is MCPServerConfig {
  if (!isRecord(value)) return false
  if (!commonMcpConfig(value)) return false
  if (value.type === 'http' || value.type === 'sse') {
    return remoteMcpConfig(value)
  }
  return stdioMcpConfig(value)
}

function environmentInput(value: unknown): SessionEnvironmentInput | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.ref !== 'string' || !value.ref) {
    throw new Error('environment requires a ref')
  }
  if (value.pluginId !== undefined && (typeof value.pluginId !== 'string' || !value.pluginId)) {
    throw new Error('environment pluginId must be a non-empty string')
  }
  return {
    ref: value.ref,
    ...(typeof value.pluginId === 'string' ? { pluginId: value.pluginId } : {})
  }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  if (entries.some(([, item]) => typeof item !== 'string')) return undefined
  return Object.fromEntries(entries) as Record<string, string>
}

export async function bindSessionEnvironment(
  value: unknown,
  options: { sessionId: string; cwd: string; request: HostRequest }
): Promise<PhiExtensionEnvironmentBinding | undefined> {
  const input = environmentInput(value)
  if (!input) return undefined
  const result = await options.request('environments.bindSession', {
    runtimeSessionId: options.sessionId,
    ref: input.ref,
    agent: 'Main',
    cwd: options.cwd,
    ...(input.pluginId ? { pluginId: input.pluginId } : {})
  })
  if (!isRecord(result)) throw new Error('environments.bindSession returned an invalid result')
  if (isRecord(result.notReady)) {
    throw new Error(
      typeof result.notReady.message === 'string' && result.notReady.message
        ? result.notReady.message
        : `environment ${input.ref} is not ready`
    )
  }
  const variables = stringRecord(result.variables)
  if (typeof result.ref !== 'string' || !result.ref || !variables) {
    throw new Error('environments.bindSession returned an invalid result')
  }
  return {
    ref: result.ref,
    variables,
    ...(input.pluginId ? { pluginId: input.pluginId } : {})
  }
}
