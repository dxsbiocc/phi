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
import { join } from 'node:path'

import {
  normalizeRemoteEnvironmentToolPaths,
  type RemoteEnvironmentToolPaths
} from '../../shared/remoteEnvironmentTypes'
import { getPhiAgentDir } from './runtime-paths'

const STORE_FILE = 'remote-environment-paths.json'
const STORE_VERSION = 1

interface RemoteEnvironmentStore {
  version: number
  entries: Readonly<Record<string, RemoteEnvironmentToolPaths>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validHostProfileId(value: string): boolean {
  return value.length > 0 && !/[\0\r\n]/.test(value)
}

function checkedHostProfileId(value: string): string {
  if (!validHostProfileId(value)) throw new Error('远程主机档案 ID 无效')
  return value
}

function readStore(agentDir: string): RemoteEnvironmentStore {
  const path = remoteEnvironmentStorePath(agentDir)
  if (!existsSync(path)) return { version: STORE_VERSION, entries: {} }
  try {
    const document: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(document) || document.version !== STORE_VERSION || !isRecord(document.entries)) {
      return { version: STORE_VERSION, entries: {} }
    }
    const entries = Object.fromEntries(
      Object.entries(document.entries).flatMap(([id, value]) => {
        if (!validHostProfileId(id) || !isRecord(value)) return []
        try {
          const paths = normalizeRemoteEnvironmentToolPaths(value)
          return Object.keys(paths).length ? [[id, paths]] : []
        } catch {
          return []
        }
      })
    )
    return { version: STORE_VERSION, entries }
  } catch {
    return { version: STORE_VERSION, entries: {} }
  }
}

function writeStore(agentDir: string, store: RemoteEnvironmentStore): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  const target = remoteEnvironmentStorePath(agentDir)
  const temporary = join(agentDir, `.${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, {
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

export function remoteEnvironmentStorePath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, STORE_FILE)
}

export function readHostRemoteEnvironmentPaths(
  hostProfileId: string,
  agentDir = getPhiAgentDir()
): RemoteEnvironmentToolPaths {
  return readStore(agentDir).entries[checkedHostProfileId(hostProfileId)] ?? {}
}

export function saveHostRemoteEnvironmentPaths(
  hostProfileId: string,
  value: RemoteEnvironmentToolPaths | null | undefined,
  agentDir = getPhiAgentDir()
): void {
  const id = checkedHostProfileId(hostProfileId)
  const store = readStore(agentDir)
  const entries = { ...store.entries }
  const paths = normalizeRemoteEnvironmentToolPaths(value)
  if (Object.keys(paths).length) entries[id] = paths
  else delete entries[id]
  writeStore(agentDir, { version: STORE_VERSION, entries })
}
