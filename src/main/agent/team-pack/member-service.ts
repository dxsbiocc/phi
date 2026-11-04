import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  exportMemberKeyBackup,
  importMemberKeyBackup,
  loadMemberKeyMaterial,
  MEMBER_PRIVATE_KEY_FILE,
  MEMBER_PUBLIC_KEY_FILE,
  storeMemberKeyMaterial,
  type SafeStorageLike
} from './key-store'
import { createMemberKeys, formatMemberPublicKey, type MemberKeys } from './keys'
import { teamPackError } from './errors'

export const MEMBER_KEY_DIRECTORY = join('team-pack', 'member')

export interface MemberIdentityOptions {
  agentDir: string
  safeStorage: SafeStorageLike
}

export interface ExportMemberIdentityBackupOptions extends MemberIdentityOptions {
  backupPath: string
  passphrase: string
}

export interface ImportMemberIdentityBackupOptions extends MemberIdentityOptions {
  backupPath: string
  passphrase: string
  expectedRecipient?: string
}

const pendingLoads = new Map<string, Promise<MemberKeys>>()

export function memberKeyDirectory(agentDir: string): string {
  if (typeof agentDir !== 'string' || agentDir.trim().length === 0) {
    throw teamPackError('INVALID_FORMAT', 'Phi agent 目录不能为空')
  }
  return join(resolve(agentDir), MEMBER_KEY_DIRECTORY)
}

/** Loads the member identity, creating and safely persisting it on first use. */
export async function loadOrCreateMemberIdentity(
  options: MemberIdentityOptions
): Promise<MemberKeys> {
  const keyDir = memberKeyDirectory(options.agentDir)
  const pending = pendingLoads.get(keyDir)
  if (pending) return pending

  const operation = loadOrCreateMemberIdentityAt(keyDir, options.safeStorage)
  pendingLoads.set(keyDir, operation)
  try {
    return await operation
  } finally {
    if (pendingLoads.get(keyDir) === operation) pendingLoads.delete(keyDir)
  }
}

/** Returns the public age recipient suitable for copying through a future IPC handler. */
export async function getMemberRecipient(options: MemberIdentityOptions): Promise<string> {
  return (await loadOrCreateMemberIdentity(options)).recipient
}

/** Returns the versioned age + Ed25519 public identity used for new member registrations. */
export async function getMemberPublicKey(options: MemberIdentityOptions): Promise<string> {
  return formatMemberPublicKey(await loadOrCreateMemberIdentity(options))
}

/** Exports the current member identity as a passphrase-encrypted age backup. */
export async function exportMemberIdentityBackup(
  options: ExportMemberIdentityBackupOptions
): Promise<void> {
  const keys = await loadOrCreateMemberIdentity(options)
  await exportMemberKeyBackup({
    backupPath: options.backupPath,
    keys,
    passphrase: options.passphrase
  })
}

/** Imports a passphrase backup and persists it using system encrypted storage. */
export async function importMemberIdentityBackup(
  options: ImportMemberIdentityBackupOptions
): Promise<string> {
  const keys = await importMemberKeyBackup({
    backupPath: options.backupPath,
    passphrase: options.passphrase,
    expectedRecipient: options.expectedRecipient
  })
  await storeMemberKeyMaterial({
    keyDir: memberKeyDirectory(options.agentDir),
    keys,
    safeStorage: options.safeStorage
  })
  return keys.recipient
}

async function loadOrCreateMemberIdentityAt(
  keyDir: string,
  safeStorage: SafeStorageLike
): Promise<MemberKeys> {
  const publicPath = join(keyDir, MEMBER_PUBLIC_KEY_FILE)
  const privatePath = join(keyDir, MEMBER_PRIVATE_KEY_FILE)
  if (existsSync(publicPath) || existsSync(privatePath)) {
    return loadMemberKeyMaterial({ keyDir, safeStorage })
  }

  const keys = await createMemberKeys()
  await storeMemberKeyMaterial({ keyDir, keys, safeStorage })
  return keys
}
