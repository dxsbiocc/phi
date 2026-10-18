import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'

const CREDENTIALS_FILE = 'mcp-credentials.json'
const LEGACY_CREDENTIALS_FILE = 'api-credentials.json'

/** Electron's `safeStorage` shape, injectable for tests. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

const nodeRequire = createRequire(import.meta.url)

function getSafeStorage(): SafeStorageLike {
  let electronModule: { safeStorage?: SafeStorageLike } | undefined
  try {
    electronModule = nodeRequire('electron') as { safeStorage?: SafeStorageLike }
  } catch {
    // A packaged app's bun worker has no `electron` package to resolve.
    electronModule = undefined
  }
  if (!electronModule?.safeStorage) {
    throw new Error('safeStorage is unavailable outside the Electron main process')
  }
  return electronModule.safeStorage
}

function getCredentialsPath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, CREDENTIALS_FILE)
}

function getLegacyCredentialsPath(agentDir: string): string {
  return join(agentDir, 'db-connectors', LEGACY_CREDENTIALS_FILE)
}

type CredentialStore = Record<string, string>

function readStoreFile(path: string): CredentialStore | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as CredentialStore)
      : undefined
  } catch {
    return undefined
  }
}

function readStore(agentDir: string): CredentialStore {
  return (
    readStoreFile(getCredentialsPath(agentDir)) ??
    readStoreFile(getLegacyCredentialsPath(agentDir)) ??
    {}
  )
}

function writeStore(store: CredentialStore, agentDir: string): void {
  const path = getCredentialsPath(agentDir)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (existsSync(path)) chmodSync(path, 0o600)
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  const legacyPath = getLegacyCredentialsPath(agentDir)
  if (existsSync(legacyPath)) unlinkSync(legacyPath)
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
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) throw new Error('Invalid credential name')
  const trimmed = secret.trim()
  if (!trimmed) throw new Error('Credentials must not be empty')
  const safeStorage = safeStorageImpl ?? getSafeStorage()
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
  ) {
    throw new Error(
      'Credentials cannot be saved because encrypted storage is unavailable on this system (safeStorage unavailable)'
    )
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
