import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'

const CREDENTIALS_FILE = 'api-credentials.json'

/** Electron's `safeStorage` shape, injectable for tests. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

const nodeRequire = createRequire(import.meta.url)

function getSafeStorage(): SafeStorageLike {
  const electronModule = nodeRequire('electron') as { safeStorage?: SafeStorageLike }
  if (!electronModule?.safeStorage) {
    throw new Error('safeStorage 不可用：当前不在 Electron 主进程环境中运行')
  }
  return electronModule.safeStorage
}

function getCredentialsPath(agentDir = getPhiAgentDir()): string {
  // Preserve the existing main-side location so this merge does not strand
  // already-encrypted MCP keys. Only the source module moves out of db/.
  return join(agentDir, 'db-connectors', CREDENTIALS_FILE)
}

type CredentialStore = Record<string, string>

function readStore(agentDir: string): CredentialStore {
  const path = getCredentialsPath(agentDir)
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as CredentialStore)
      : {}
  } catch {
    return {}
  }
}

function writeStore(store: CredentialStore, agentDir: string): void {
  const path = getCredentialsPath(agentDir)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (existsSync(path)) chmodSync(path, 0o600)
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
}

export function isCredentialStorageAvailable(safeStorageImpl?: SafeStorageLike): boolean {
  try {
    const safeStorage = safeStorageImpl ?? getSafeStorage()
    return (
      safeStorage.isEncryptionAvailable() &&
      !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
    )
  } catch {
    return false
  }
}

/** Stores a secret encrypted with Electron safeStorage. Plaintext never reaches disk. */
export function storeCredentialSecret(
  name: string,
  secret: string,
  agentDir = getPhiAgentDir(),
  safeStorageImpl?: SafeStorageLike
): void {
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) throw new Error('无效的凭据名称')
  const trimmed = secret.trim()
  if (!trimmed) throw new Error('凭据不能为空')
  const safeStorage = safeStorageImpl ?? getSafeStorage()
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
  ) {
    throw new Error('当前系统不支持加密存储（safeStorage 不可用），无法保存凭据')
  }
  const store = readStore(agentDir)
  store[name] = safeStorage.encryptString(trimmed).toString('base64')
  writeStore(store, agentDir)
}

export function clearCredentialSecret(name: string, agentDir = getPhiAgentDir()): void {
  const store = readStore(agentDir)
  if (!(name in store)) return
  delete store[name]
  writeStore(store, agentDir)
}

export function readCredentialSecret(
  name: string,
  agentDir = getPhiAgentDir(),
  safeStorageImpl?: SafeStorageLike
): string | undefined {
  const encoded = readStore(agentDir)[name]
  if (encoded === undefined) return undefined
  try {
    const safeStorage = safeStorageImpl ?? getSafeStorage()
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
    ) {
      return undefined
    }
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch {
    return undefined
  }
}
