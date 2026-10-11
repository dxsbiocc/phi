import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, posix } from 'node:path'

import type { RemoteProjectMcpTrustState } from '../../../shared/remoteProjectMcpTypes'
import { getPhiAgentDir } from '../runtime-paths'

const STORE_FILE = 'remote-mcp-trust.json'
const STORE_VERSION = 1
const CONFIG_PATHS = new Set(['.phi/mcp.json', '.mcp.json', '.omp/mcp.json', '.pi/mcp.json'])

export interface RemoteProjectMcpTrustIdentity {
  hostAlias: string
  projectRoot: string
  relativePath: string
  contentHash: string
}

interface Store {
  version: number
  entries: RemoteProjectMcpTrustIdentity[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkedText(value: string, label: string): string {
  if (!value || /[\0\r\n]/u.test(value)) throw new Error(`${label}无效`)
  return value
}

function normalizeIdentity(value: RemoteProjectMcpTrustIdentity): RemoteProjectMcpTrustIdentity {
  const hostAlias = checkedText(value.hostAlias, '远程主机别名')
  const projectRoot = posix.normalize(checkedText(value.projectRoot, '远程项目根目录'))
  const relativePath = posix.normalize(
    checkedText(value.relativePath, '远程 MCP 配置相对路径').replace(/^\.\//u, '')
  )
  const contentHash = checkedText(value.contentHash, '远程 MCP 配置内容哈希').toLowerCase()
  if (!posix.isAbsolute(projectRoot) || projectRoot.includes('\\')) {
    throw new Error('远程项目根目录无效')
  }
  if (!CONFIG_PATHS.has(relativePath)) throw new Error('远程 MCP 配置相对路径无效')
  if (!/^[a-f0-9]{64}$/u.test(contentHash)) throw new Error('远程 MCP 配置内容哈希无效')
  return {
    hostAlias,
    projectRoot: projectRoot === '/' ? projectRoot : projectRoot.replace(/\/+$/u, ''),
    relativePath,
    contentHash
  }
}

function sameFile(
  left: RemoteProjectMcpTrustIdentity,
  right: RemoteProjectMcpTrustIdentity
): boolean {
  return (
    left.hostAlias === right.hostAlias &&
    left.projectRoot === right.projectRoot &&
    left.relativePath === right.relativePath
  )
}

function parsedEntry(value: unknown): RemoteProjectMcpTrustIdentity | undefined {
  if (
    !isRecord(value) ||
    typeof value.hostAlias !== 'string' ||
    typeof value.projectRoot !== 'string' ||
    typeof value.relativePath !== 'string' ||
    typeof value.contentHash !== 'string'
  ) {
    return undefined
  }
  try {
    return normalizeIdentity(value as unknown as RemoteProjectMcpTrustIdentity)
  } catch {
    return undefined
  }
}

function readStore(agentDir: string): Store {
  const path = remoteProjectMcpTrustStorePath(agentDir)
  if (!existsSync(path)) return { version: STORE_VERSION, entries: [] }
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(value) || value.version !== STORE_VERSION || !Array.isArray(value.entries)) {
      return { version: STORE_VERSION, entries: [] }
    }
    return {
      version: STORE_VERSION,
      entries: value.entries.flatMap((entry) => {
        const parsed = parsedEntry(entry)
        return parsed ? [parsed] : []
      })
    }
  } catch {
    return { version: STORE_VERSION, entries: [] }
  }
}

function writeStore(agentDir: string, entries: RemoteProjectMcpTrustIdentity[]): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  const target = remoteProjectMcpTrustStorePath(agentDir)
  const temporary = join(agentDir, `.${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: STORE_VERSION, entries }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    renameSync(temporary, target)
    chmodSync(target, 0o600)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function remoteProjectMcpTrustStorePath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, STORE_FILE)
}

export function remoteProjectMcpTrustState(
  identity: RemoteProjectMcpTrustIdentity,
  agentDir = getPhiAgentDir()
): Exclude<RemoteProjectMcpTrustState, 'invalid'> {
  const normalized = normalizeIdentity(identity)
  const matches = readStore(agentDir).entries.filter((entry) => sameFile(entry, normalized))
  if (matches.some((entry) => entry.contentHash === normalized.contentHash)) return 'trusted'
  return matches.length > 0 ? 'changed' : 'pending'
}

export function trustRemoteProjectMcpIdentity(
  identity: RemoteProjectMcpTrustIdentity,
  agentDir = getPhiAgentDir()
): void {
  const normalized = normalizeIdentity(identity)
  const entries = readStore(agentDir).entries.filter((entry) => !sameFile(entry, normalized))
  entries.push(normalized)
  writeStore(agentDir, entries)
}

export function revokeRemoteProjectMcpIdentity(
  identity: RemoteProjectMcpTrustIdentity,
  agentDir = getPhiAgentDir()
): void {
  const normalized = normalizeIdentity(identity)
  const entries = readStore(agentDir).entries.filter((entry) => !sameFile(entry, normalized))
  writeStore(agentDir, entries)
}
