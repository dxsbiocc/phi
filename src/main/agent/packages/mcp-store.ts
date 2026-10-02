import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import semver from 'semver'

import { getPhiAgentDir } from '../runtime-paths'

export interface InstalledMcpState {
  version: string
  installedAt: string
}

export interface McpPackagesRegistry {
  version: 1
  packages: Record<string, InstalledMcpState>
}

export function mcpPackagesRegistryPath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'packages', 'mcp-packages.json')
}

export function mcpPackagesDir(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'packages', 'mcp')
}

export function mcpVersionDir(id: string, version: string, agentDir = getPhiAgentDir()): string {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new Error(`invalid MCP package id '${id}'`)
  if (!semver.valid(version)) throw new Error(`invalid MCP package version '${version}'`)
  return join(mcpPackagesDir(agentDir), id, version)
}

export function readMcpPackagesRegistry(agentDir = getPhiAgentDir()): McpPackagesRegistry {
  const file = mcpPackagesRegistryPath(agentDir)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { version: 1, packages: {} }
    if (error instanceof SyntaxError) throw new Error(`invalid MCP package registry JSON: ${file}`)
    throw error
  }
  if (!isMcpPackagesRegistry(value)) throw new Error(`invalid MCP package registry: ${file}`)
  return value
}

export function writeMcpPackagesRegistry(
  registry: McpPackagesRegistry,
  agentDir = getPhiAgentDir()
): void {
  if (!isMcpPackagesRegistry(registry)) {
    throw new Error('refusing to write an invalid MCP package registry')
  }
  const target = mcpPackagesRegistryPath(agentDir)
  const parent = dirname(target)
  mkdirSync(parent, { recursive: true })
  const temporary = join(
    parent,
    `.mcp-packages.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  )
  try {
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file may not exist if the initial write failed.
    }
    throw error
  }
}

export function listActiveMcpPackages(
  agentDir = getPhiAgentDir()
): Array<{ id: string; version: string; dir: string }> {
  return Object.entries(readMcpPackagesRegistry(agentDir).packages)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([id, entry]) => {
      const dir = mcpVersionDir(id, entry.version, agentDir)
      return existsSync(join(dir, 'phi-package.yaml')) ? [{ id, version: entry.version, dir }] : []
    })
}

function isMcpPackagesRegistry(value: unknown): value is McpPackagesRegistry {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.packages)) return false
  return Object.entries(value.packages).every(
    ([id, entry]) =>
      /^[a-z][a-z0-9-]{1,63}$/.test(id) &&
      isRecord(entry) &&
      typeof entry.version === 'string' &&
      semver.valid(entry.version) !== null &&
      typeof entry.installedAt === 'string' &&
      Number.isFinite(Date.parse(entry.installedAt))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}
