import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { generateX25519Identity, identityToRecipient } from 'age-encryption'

import { publicKeyPem, registryKeyId } from '../packages/signature'
import { teamPackError } from './errors'
import {
  assertTeamId,
  assertTeamName,
  assertX25519Identity,
  assertX25519Recipient
} from './validation'

export interface TeamKeys {
  version: 1
  teamId: string
  name: string
  publicKey: string
  privateKey: string
  keyId: string
}

export interface MemberKeys {
  version: 1
  identity: string
  recipient: string
}

export interface CreateTeamKeysOptions {
  teamId?: string
  name?: string
}

export function createTeamKeys(options: CreateTeamKeysOptions = {}): TeamKeys {
  const teamId = options.teamId ?? `team-${randomUUID()}`
  const name = options.name ?? 'Team'
  assertTeamId(teamId)
  assertTeamName(name)
  const pair = generateKeyPairSync('ed25519')
  const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  return { version: 1, teamId, name, publicKey, privateKey, keyId: registryKeyId(publicKey) }
}

export async function createMemberKeys(): Promise<MemberKeys> {
  const identity = await generateX25519Identity()
  const recipient = await identityToRecipient(identity)
  return { version: 1, identity, recipient }
}

export function writeTeamKeys(path: string, keys: TeamKeys): void {
  try {
    validateTeamKeys(keys)
  } catch {
    throw teamPackError('INVALID_FORMAT', '团队密钥文件格式无效')
  }
  writePrivateJson(path, keys)
}

export function readTeamKeys(path: string): TeamKeys {
  const value = readPrivateJson(path)
  try {
    validateTeamKeys(value)
    return value
  } catch {
    throw teamPackError('INVALID_FORMAT', '团队密钥文件格式无效')
  }
}

export function writeMemberKeys(path: string, keys: MemberKeys): void {
  try {
    validateMemberKeysShape(keys)
  } catch {
    throw teamPackError('INVALID_FORMAT', '成员密钥文件格式无效')
  }
  writePrivateJson(path, keys)
}

export async function readMemberKeys(path: string): Promise<MemberKeys> {
  const value = readPrivateJson(path)
  try {
    validateMemberKeysShape(value)
    const recipient = await identityToRecipient(value.identity)
    if (recipient !== value.recipient) throw new Error('recipient mismatch')
    return value
  } catch {
    throw teamPackError('INVALID_FORMAT', '成员密钥文件格式无效')
  }
}

function validateTeamKeys(value: unknown): asserts value is TeamKeys {
  if (!isRecord(value) || value.version !== 1) throw new Error('invalid team key file')
  assertTeamId(value.teamId)
  assertTeamName(value.name)
  if (
    typeof value.publicKey !== 'string' ||
    typeof value.privateKey !== 'string' ||
    typeof value.keyId !== 'string'
  ) {
    throw new Error('invalid team key file')
  }
  const derivedPublicKey = publicKeyPem(value.privateKey)
  if (
    derivedPublicKey !== value.publicKey ||
    registryKeyId(value.publicKey) !== value.keyId ||
    !/^[a-f0-9]{16}$/.test(value.keyId)
  ) {
    throw new Error('invalid team key file')
  }
}

function validateMemberKeysShape(value: unknown): asserts value is MemberKeys {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('invalid member key file')
  }
  assertX25519Identity(value.identity)
  assertX25519Recipient(value.recipient)
}

function writePrivateJson(path: string, value: unknown): void {
  if (!path) throw teamPackError('INVALID_FORMAT', '密钥文件路径不能为空')
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Best-effort cleanup; never include secret material in the surfaced error.
    }
    throw teamPackError('STORE_UNAVAILABLE', '无法写入密钥文件', error)
  }
}

function readPrivateJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw teamPackError('INVALID_FORMAT', '无法读取密钥文件', error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
