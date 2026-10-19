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

import { getPhiAgentDir } from '../runtime-paths'

import { isRecord } from '../../../shared/guards'

const STORE_FILE = 'remote-agent-trust.json'
const STORE_VERSION = 1

export type RemoteAgentTrustState = 'pending' | 'trusted' | 'changed'

export interface RemoteAgentTrustIdentity {
  hostAlias: string
  projectRoot: string
  relativePath: string
  contentHash: string
}

interface RemoteAgentTrustStore {
  version: number
  entries: RemoteAgentTrustIdentity[]
}

function checkedText(value: string, label: string): string {
  if (!value || /[\0\r\n]/.test(value)) throw new Error(`${label} 无效`)
  return value
}

function normalizedProjectRoot(value: string): string {
  const checked = checkedText(value, '远程项目根目录')
  if (!posix.isAbsolute(checked) || checked.includes('\\')) {
    throw new Error('远程项目根目录无效')
  }
  const normalized = posix.normalize(checked)
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '')
}

function normalizedRelativePath(value: string): string {
  const checked = checkedText(value, '远程 agent 相对路径')
  if (posix.isAbsolute(checked) || checked.includes('\\') || checked.split('/').includes('..')) {
    throw new Error('远程 agent 相对路径无效')
  }
  const normalized = posix.normalize(checked.replace(/^\.\//, ''))
  if (normalized === '.' || !normalized.endsWith('.md')) {
    throw new Error('远程 agent 相对路径无效')
  }
  return normalized
}

function normalizedIdentity(value: RemoteAgentTrustIdentity): RemoteAgentTrustIdentity {
  const contentHash = checkedText(value.contentHash, '远程 agent 内容哈希').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('远程 agent 内容哈希无效')
  return {
    hostAlias: checkedText(value.hostAlias, '远程主机别名'),
    projectRoot: normalizedProjectRoot(value.projectRoot),
    relativePath: normalizedRelativePath(value.relativePath),
    contentHash
  }
}

function sameFile(left: RemoteAgentTrustIdentity, right: RemoteAgentTrustIdentity): boolean {
  return (
    left.hostAlias === right.hostAlias &&
    left.projectRoot === right.projectRoot &&
    left.relativePath === right.relativePath
  )
}

function parsedEntry(value: unknown): RemoteAgentTrustIdentity | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.hostAlias !== 'string' ||
    typeof value.projectRoot !== 'string' ||
    typeof value.relativePath !== 'string' ||
    typeof value.contentHash !== 'string'
  ) {
    return undefined
  }
  try {
    return normalizedIdentity(value as unknown as RemoteAgentTrustIdentity)
  } catch {
    return undefined
  }
}

function readStore(agentDir: string): RemoteAgentTrustStore {
  const path = remoteAgentTrustStorePath(agentDir)
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

function writeStore(agentDir: string, entries: RemoteAgentTrustIdentity[]): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  const target = remoteAgentTrustStorePath(agentDir)
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

export function remoteAgentTrustStorePath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, STORE_FILE)
}

export function remoteAgentTrustState(
  identity: RemoteAgentTrustIdentity,
  agentDir = getPhiAgentDir()
): RemoteAgentTrustState {
  const normalized = normalizedIdentity(identity)
  const matching = readStore(agentDir).entries.filter((entry) => sameFile(entry, normalized))
  if (matching.some((entry) => entry.contentHash === normalized.contentHash)) return 'trusted'
  return matching.length > 0 ? 'changed' : 'pending'
}

export function trustRemoteProjectAgent(
  identity: RemoteAgentTrustIdentity,
  agentDir = getPhiAgentDir()
): void {
  const normalized = normalizedIdentity(identity)
  const entries = readStore(agentDir).entries.filter((entry) => !sameFile(entry, normalized))
  entries.push(normalized)
  writeStore(agentDir, entries)
}

export function revokeRemoteProjectAgentTrust(
  identity: RemoteAgentTrustIdentity,
  agentDir = getPhiAgentDir()
): void {
  const normalized = normalizedIdentity(identity)
  const entries = readStore(agentDir).entries.filter((entry) => !sameFile(entry, normalized))
  writeStore(agentDir, entries)
}
