import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import { getWrappersRootDir } from './store'

const CREDENTIALS_FILE = 'remote-credentials.json'

/** Electron's `safeStorage` shape — exported so tests can inject a fake instead of the real OS keychain. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

const nodeRequire = createRequire(import.meta.url)

/**
 * Loaded lazily via `require`, not a static `import { safeStorage } from
 * 'electron'` — the latter makes this file (and everything that
 * transitively imports it, including `runs.ts`) fail to even load under
 * the plain `node --test` runner this project's tests use: outside a real
 * Electron process, the `electron` package's module shape doesn't match
 * what ESM's static named-export analysis expects, so the import throws a
 * `SyntaxError` at load time regardless of whether `safeStorage` is ever
 * called. Real usage only happens inside the actual Electron main process,
 * where this resolves exactly like the direct import would.
 */
function getSafeStorage(): SafeStorageLike {
  const electronModule = nodeRequire('electron') as { safeStorage?: SafeStorageLike }
  if (!electronModule?.safeStorage) {
    throw new Error('safeStorage 不可用：当前不在 Electron 主进程环境中运行')
  }
  return electronModule.safeStorage
}

/**
 * The only secret this module ever handles is an SSH key's passphrase,
 * encrypted at rest via Electron's `safeStorage` (OS keychain-backed:
 * Keychain on macOS, DPAPI on Windows, libsecret on Linux). Keyed by
 * `ProjectRemoteConnection.id`, not by project id — a connection's
 * passphrase survives being reassigned between projects, and doesn't leak
 * into `projects.json` (a plain, unencrypted JSON file) at all. The key
 * material itself is never stored here or anywhere else in Phi — see
 * `ProjectRemoteConnection.privateKeyPath`'s doc comment.
 */

function getCredentialsPath(agentDir = getPhiAgentDir()): string {
  return join(getWrappersRootDir(agentDir), CREDENTIALS_FILE)
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
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf-8')
}

export function isRemoteCredentialStorageAvailable(safeStorageImpl?: SafeStorageLike): boolean {
  try {
    return (safeStorageImpl ?? getSafeStorage()).isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * Throws rather than silently falling back to plaintext when the OS
 * keychain isn't available (some headless/unconfigured Linux setups, or —
 * see `getSafeStorage` — not running inside Electron at all) — matches the
 * project's "no hardcoded/plaintext secrets" rule. Callers should tell the
 * user to use a passphrase-less key in that case. `safeStorageImpl` is
 * injectable — mirrors `executor-local.ts`'s `spawnImpl`/`doctorImpl` — so
 * tests can exercise real encrypt/decrypt round-trips without the actual OS
 * keychain (which the plain `node --test` runner has no access to anyway).
 */
export function storeRemoteConnectionPassphrase(
  connectionId: string,
  passphrase: string,
  agentDir = getPhiAgentDir(),
  safeStorageImpl?: SafeStorageLike
): void {
  const safeStorage = safeStorageImpl ?? getSafeStorage()
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统不支持加密存储（safeStorage 不可用），无法保存 SSH 密钥口令')
  }
  const store = readStore(agentDir)
  store[connectionId] = safeStorage.encryptString(passphrase).toString('base64')
  writeStore(store, agentDir)
}

/** Returns undefined if nothing is stored for this connection, or if the keychain isn't available right now. */
export function readRemoteConnectionPassphrase(
  connectionId: string,
  agentDir = getPhiAgentDir(),
  safeStorageImpl?: SafeStorageLike
): string | undefined {
  const encoded = readStore(agentDir)[connectionId]
  if (encoded === undefined) return undefined
  try {
    const safeStorage = safeStorageImpl ?? getSafeStorage()
    if (!safeStorage.isEncryptionAvailable()) return undefined
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch {
    return undefined
  }
}

export function deleteRemoteConnectionPassphrase(
  connectionId: string,
  agentDir = getPhiAgentDir()
): void {
  const store = readStore(agentDir)
  if (!(connectionId in store)) return
  delete store[connectionId]
  writeStore(store, agentDir)
}
