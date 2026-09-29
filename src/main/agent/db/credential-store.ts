import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import { getDbConnectorsRootDir } from './store'

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
  return join(getDbConnectorsRootDir(agentDir), CREDENTIALS_FILE)
}

type CredentialStore = Record<string, string>

function readStore(agentDir: string): CredentialStore {
  const path = getCredentialsPath(agentDir)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as CredentialStore) : {}
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

export function isDbCredentialStorageAvailable(safeStorageImpl?: SafeStorageLike): boolean {
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

/**
 * Stores a DB API secret encrypted via Electron safeStorage, keyed by env var name
 * (e.g. NCBI_API_KEY). Never writes plaintext secrets to disk.
 */
export function storeDbConnectorSecret(
  envVar: string,
  secret: string,
  agentDir = getPhiAgentDir(),
  safeStorageImpl?: SafeStorageLike
): void {
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(envVar)) {
    throw new Error('无效的环境变量名')
  }
  const trimmed = secret.trim()
  if (!trimmed) {
    throw new Error('API key 不能为空')
  }
  const safeStorage = safeStorageImpl ?? getSafeStorage()
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
  ) {
    throw new Error('当前系统不支持加密存储（safeStorage 不可用），无法保存数据库 API key')
  }
  const store = readStore(agentDir)
  store[envVar] = safeStorage.encryptString(trimmed).toString('base64')
  writeStore(store, agentDir)
}

export function clearDbConnectorSecret(envVar: string, agentDir = getPhiAgentDir()): void {
  const store = readStore(agentDir)
  if (!(envVar in store)) return
  delete store[envVar]
  writeStore(store, agentDir)
}

export function readDbConnectorSecret(
  envVar: string,
  agentDir = getPhiAgentDir(),
  safeStorageImpl?: SafeStorageLike
): string | undefined {
  const encoded = readStore(agentDir)[envVar]
  if (encoded === undefined) return undefined
  try {
    const safeStorage = safeStorageImpl ?? getSafeStorage()
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
    )
      return undefined
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch {
    return undefined
  }
}

export function hasDbConnectorSecret(envVar: string, agentDir = getPhiAgentDir()): boolean {
  return Object.prototype.hasOwnProperty.call(readStore(agentDir), envVar)
}

/**
 * Resolve a connector auth secret: prefer live process.env, then settings-backed store.
 * Does not mutate process.env.
 */
export function resolveDbAuthSecret(
  envVar: string | undefined,
  agentDir = getPhiAgentDir(),
  safeStorageImpl?: SafeStorageLike
): string | undefined {
  if (!envVar) return undefined
  const fromEnv = process.env[envVar]
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return readDbConnectorSecret(envVar, agentDir, safeStorageImpl)
}
