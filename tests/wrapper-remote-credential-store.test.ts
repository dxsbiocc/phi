import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  deleteRemoteConnectionPassphrase,
  isRemoteCredentialStorageAvailable,
  readRemoteConnectionPassphrase,
  storeRemoteConnectionPassphrase,
  type SafeStorageLike
} from '../src/main/agent/wrappers/remote-credential-store'

function withAgentDir<T>(callback: (agentDir: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-credential-store-'))
  try {
    return callback(join(root, '.phi-home'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Reversible "encryption" (base64) — real safeStorage's OS keychain isn't reachable from `node --test`. */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) => Buffer.from(plainText, 'utf-8'),
    decryptString: (encrypted) => encrypted.toString('utf-8')
  }
}

test('storeRemoteConnectionPassphrase / readRemoteConnectionPassphrase round-trip', () => {
  withAgentDir((agentDir) => {
    const safeStorage = fakeSafeStorage()
    storeRemoteConnectionPassphrase('conn1', 's3cret', agentDir, safeStorage)
    assert.equal(readRemoteConnectionPassphrase('conn1', agentDir, safeStorage), 's3cret')
  })
})

test('readRemoteConnectionPassphrase returns undefined for an unknown connection', () => {
  withAgentDir((agentDir) => {
    assert.equal(
      readRemoteConnectionPassphrase('never-stored', agentDir, fakeSafeStorage()),
      undefined
    )
  })
})

test('storeRemoteConnectionPassphrase throws instead of falling back to plaintext when encryption is unavailable', () => {
  withAgentDir((agentDir) => {
    assert.throws(
      () => storeRemoteConnectionPassphrase('conn1', 's3cret', agentDir, fakeSafeStorage(false)),
      /safeStorage 不可用|不支持加密存储/
    )
  })
})

test('readRemoteConnectionPassphrase returns undefined (not a throw) when encryption is unavailable', () => {
  withAgentDir((agentDir) => {
    const safeStorage = fakeSafeStorage()
    storeRemoteConnectionPassphrase('conn1', 's3cret', agentDir, safeStorage)
    // Same connection, but encryption has since become unavailable (e.g. keychain locked).
    assert.equal(
      readRemoteConnectionPassphrase('conn1', agentDir, fakeSafeStorage(false)),
      undefined
    )
  })
})

test('deleteRemoteConnectionPassphrase removes a stored passphrase and is a no-op for an unknown one', () => {
  withAgentDir((agentDir) => {
    const safeStorage = fakeSafeStorage()
    storeRemoteConnectionPassphrase('conn1', 's3cret', agentDir, safeStorage)
    deleteRemoteConnectionPassphrase('conn1', agentDir)
    assert.equal(readRemoteConnectionPassphrase('conn1', agentDir, safeStorage), undefined)

    // Deleting again, or deleting something never stored, must not throw.
    deleteRemoteConnectionPassphrase('conn1', agentDir)
    deleteRemoteConnectionPassphrase('never-stored', agentDir)
  })
})

test('storing two connections keeps their passphrases independent', () => {
  withAgentDir((agentDir) => {
    const safeStorage = fakeSafeStorage()
    storeRemoteConnectionPassphrase('conn1', 'first', agentDir, safeStorage)
    storeRemoteConnectionPassphrase('conn2', 'second', agentDir, safeStorage)
    assert.equal(readRemoteConnectionPassphrase('conn1', agentDir, safeStorage), 'first')
    assert.equal(readRemoteConnectionPassphrase('conn2', agentDir, safeStorage), 'second')

    deleteRemoteConnectionPassphrase('conn1', agentDir)
    assert.equal(readRemoteConnectionPassphrase('conn1', agentDir, safeStorage), undefined)
    assert.equal(readRemoteConnectionPassphrase('conn2', agentDir, safeStorage), 'second')
  })
})

test('isRemoteCredentialStorageAvailable reflects the injected implementation', () => {
  assert.equal(isRemoteCredentialStorageAvailable(fakeSafeStorage(true)), true)
  assert.equal(isRemoteCredentialStorageAvailable(fakeSafeStorage(false)), false)
})

test('isRemoteCredentialStorageAvailable is false (not a throw) outside a real Electron process', () => {
  // No injected implementation — falls through to the real `require('electron')`,
  // which under the plain `node --test` runner has no usable safeStorage.
  assert.equal(isRemoteCredentialStorageAvailable(), false)
})
