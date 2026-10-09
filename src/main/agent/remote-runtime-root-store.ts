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

import { getPhiAgentDir } from './runtime-paths'
import { normalizeRemoteRuntimeRoot } from './remote-runtime-root'

const STORE_FILE = 'remote-runtime-roots.json'
const STORE_VERSION = 1

interface RemoteRuntimeRootStore {
  version: number
  entries: Readonly<Record<string, string>>
}

function emptyStore(): RemoteRuntimeRootStore {
  return { version: STORE_VERSION, entries: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizedEntry(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return normalizeRemoteRuntimeRoot(value)
  } catch {
    return undefined
  }
}

function readStore(agentDir: string): RemoteRuntimeRootStore {
  const path = remoteRuntimeRootStorePath(agentDir)
  if (!existsSync(path)) return emptyStore()
  try {
    const document: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(document) || document.version !== STORE_VERSION || !isRecord(document.entries)) {
      return emptyStore()
    }
    const entries = Object.fromEntries(
      Object.entries(document.entries).flatMap(([key, value]) => {
        const normalized = normalizedEntry(value)
        return validHostProfileId(key) && normalized ? [[key, normalized]] : []
      })
    )
    return { version: STORE_VERSION, entries }
  } catch {
    return emptyStore()
  }
}

function writeStore(agentDir: string, store: RemoteRuntimeRootStore): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  const target = remoteRuntimeRootStorePath(agentDir)
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

function validHostProfileId(value: string): boolean {
  return value.length > 0 && !/[\0\r\n]/.test(value)
}

function checkedHostProfileId(value: string): string {
  if (!validHostProfileId(value)) throw new Error('远程主机档案 ID 无效')
  return value
}

export function remoteRuntimeRootStorePath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, STORE_FILE)
}

export function readHostRuntimeRoot(
  hostProfileId: string,
  agentDir = getPhiAgentDir()
): string | undefined {
  return readStore(agentDir).entries[checkedHostProfileId(hostProfileId)]
}

export function saveHostRuntimeRoot(
  hostProfileId: string,
  runtimeRoot: string | null | undefined,
  agentDir = getPhiAgentDir()
): void {
  const id = checkedHostProfileId(hostProfileId)
  const store = readStore(agentDir)
  const entries = { ...store.entries }
  if (runtimeRoot == null) delete entries[id]
  else entries[id] = normalizeRemoteRuntimeRoot(runtimeRoot)
  writeStore(agentDir, { version: STORE_VERSION, entries })
}
