import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID
} from 'node:crypto'
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
  version: 2
  teamId: string
  name: string
  publicKey: string
  privateKey: string
  keyId: string
  submissionIdentity: string
  submissionRecipient: string
}

export interface MemberKeys {
  version: 2
  identity: string
  recipient: string
  signingPublicKey: string
  signingPrivateKey: string
  signingKeyId: string
}

export interface ParsedMemberPublicKey {
  recipient: string
  signingPublicKey?: string
  signingKeyId?: string
  combined: string
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
  const inbox = createAgeX25519Keys()
  return {
    version: 2,
    teamId,
    name,
    publicKey,
    privateKey,
    keyId: registryKeyId(publicKey),
    submissionIdentity: inbox.identity,
    submissionRecipient: inbox.recipient
  }
}

export async function createMemberKeys(): Promise<MemberKeys> {
  const identity = await generateX25519Identity()
  const recipient = await identityToRecipient(identity)
  return { version: 2, identity, recipient, ...createMemberSigningKeys() }
}

export function createMemberSigningKeys(): Pick<
  MemberKeys,
  'signingPublicKey' | 'signingPrivateKey' | 'signingKeyId'
> {
  const signing = generateKeyPairSync('ed25519')
  const signingPublicKey = signing.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const signingPrivateKey = signing.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  return {
    signingPublicKey,
    signingPrivateKey,
    signingKeyId: registryKeyId(signingPublicKey)
  }
}

export function formatMemberPublicKey(
  keys: Pick<MemberKeys, 'recipient' | 'signingPublicKey'>
): string {
  assertX25519Recipient(keys.recipient)
  assertEd25519PublicKey(keys.signingPublicKey)
  const payload = Buffer.from(
    JSON.stringify({ recipient: keys.recipient, signingPublicKey: keys.signingPublicKey })
  ).toString('base64url')
  return `phi-member-v1.${payload}`
}

export function parseMemberPublicKey(value: string): ParsedMemberPublicKey {
  if (typeof value !== 'string') throw teamPackError('INVALID_FORMAT', '成员公钥格式无效')
  if (!value.startsWith('phi-member-v1.')) {
    assertX25519Recipient(value)
    return { recipient: value, combined: value }
  }
  try {
    const encoded = value.slice('phi-member-v1.'.length)
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('invalid encoding')
    const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (
      !isRecord(decoded) ||
      Object.keys(decoded).sort().join(',') !== 'recipient,signingPublicKey' ||
      typeof decoded.recipient !== 'string' ||
      typeof decoded.signingPublicKey !== 'string'
    ) {
      throw new Error('invalid payload')
    }
    assertX25519Recipient(decoded.recipient)
    assertEd25519PublicKey(decoded.signingPublicKey)
    const canonical = formatMemberPublicKey({
      recipient: decoded.recipient,
      signingPublicKey: decoded.signingPublicKey
    })
    if (canonical !== value) throw new Error('non-canonical payload')
    return {
      recipient: decoded.recipient,
      signingPublicKey: decoded.signingPublicKey,
      signingKeyId: registryKeyId(decoded.signingPublicKey),
      combined: canonical
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'INVALID_FORMAT') throw error
    throw teamPackError('INVALID_FORMAT', '成员组合公钥格式无效', error)
  }
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
  if (!isRecord(value) || value.version !== 2) throw new Error('invalid team key file')
  assertTeamId(value.teamId)
  assertTeamName(value.name)
  if (
    typeof value.publicKey !== 'string' ||
    typeof value.privateKey !== 'string' ||
    typeof value.keyId !== 'string' ||
    typeof value.submissionIdentity !== 'string' ||
    typeof value.submissionRecipient !== 'string'
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
  assertX25519Identity(value.submissionIdentity)
  assertX25519Recipient(value.submissionRecipient)
  if (recipientForAgeIdentity(value.submissionIdentity) !== value.submissionRecipient) {
    throw new Error('invalid submission key pair')
  }
}

function validateMemberKeysShape(value: unknown): asserts value is MemberKeys {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    typeof value.signingPublicKey !== 'string' ||
    typeof value.signingPrivateKey !== 'string' ||
    typeof value.signingKeyId !== 'string'
  ) {
    throw new Error('invalid member key file')
  }
  assertX25519Identity(value.identity)
  assertX25519Recipient(value.recipient)
  assertEd25519KeyPair(value.signingPublicKey, value.signingPrivateKey, value.signingKeyId)
}

export function createAgeX25519Keys(): { identity: string; recipient: string } {
  const scalar = randomBytes(32)
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, scalar]),
    format: 'der',
    type: 'pkcs8'
  })
  const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  const publicKey = publicDer.subarray(publicDer.length - 32)
  return {
    identity: bech32Encode('AGE-SECRET-KEY-', scalar).toUpperCase(),
    recipient: bech32Encode('age', publicKey)
  }
}

export function recipientForAgeIdentity(identity: string): string {
  assertX25519Identity(identity)
  const normalized = identity.toLowerCase()
  const separator = normalized.lastIndexOf('1')
  const prefix = normalized.slice(0, separator)
  const encoded = normalized.slice(separator + 1)
  if (prefix !== 'age-secret-key-' || encoded.length < 7) {
    throw teamPackError('INVALID_FORMAT', 'age X25519 私钥格式无效')
  }
  const words = [...encoded].map((character) => {
    const value = BECH32_ALPHABET.indexOf(character)
    if (value < 0) throw teamPackError('INVALID_FORMAT', 'age X25519 私钥格式无效')
    return value
  })
  if (!validBech32Checksum(prefix, words)) {
    throw teamPackError('INVALID_FORMAT', 'age X25519 私钥校验和无效')
  }
  const scalar = Buffer.from(convertBitsStrict(words.slice(0, -6), 5, 8))
  if (scalar.length !== 32) throw teamPackError('INVALID_FORMAT', 'age X25519 私钥格式无效')
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, scalar]),
    format: 'der',
    type: 'pkcs8'
  })
  const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  return bech32Encode('age', publicDer.subarray(publicDer.length - 32))
}

function assertEd25519PublicKey(publicKey: string): void {
  try {
    if (createPublicKey(publicKey).asymmetricKeyType !== 'ed25519')
      throw new Error('wrong key type')
  } catch (error) {
    throw teamPackError('INVALID_FORMAT', '成员签名公钥格式无效', error)
  }
}

function assertEd25519KeyPair(publicKey: string, privateKey: string, keyId: string): void {
  assertEd25519PublicKey(publicKey)
  if (
    publicKeyPem(privateKey) !== publicKey ||
    registryKeyId(publicKey) !== keyId ||
    !/^[a-f0-9]{16}$/.test(keyId)
  ) {
    throw new Error('invalid member signing key')
  }
}

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function bech32Encode(prefix: string, bytes: Uint8Array): string {
  const words = convertBits(bytes, 8, 5)
  const checksum = bech32Checksum(prefix.toLowerCase(), words)
  return `${prefix}1${[...words, ...checksum].map((word) => BECH32_ALPHABET[word]).join('')}`
}

function convertBits(bytes: Uint8Array, fromBits: number, toBits: number): number[] {
  let accumulator = 0
  let bits = 0
  const output: number[] = []
  const mask = (1 << toBits) - 1
  for (const byte of bytes) {
    accumulator = (accumulator << fromBits) | byte
    bits += fromBits
    while (bits >= toBits) {
      bits -= toBits
      output.push((accumulator >> bits) & mask)
    }
  }
  if (bits > 0) output.push((accumulator << (toBits - bits)) & mask)
  return output
}

function bech32Checksum(prefix: string, words: number[]): number[] {
  const expanded = [
    ...[...prefix].map((character) => character.charCodeAt(0) >> 5),
    0,
    ...[...prefix].map((character) => character.charCodeAt(0) & 31)
  ]
  let state = 1
  for (const value of [...expanded, ...words, 0, 0, 0, 0, 0, 0]) {
    const top = state >>> 25
    state = ((state & 0x1ffffff) << 5) ^ value
    for (let index = 0; index < 5; index++) {
      if ((top >>> index) & 1) state ^= BECH32_GENERATORS[index]!
    }
  }
  state ^= 1
  return Array.from({ length: 6 }, (_, index) => (state >>> (5 * (5 - index))) & 31)
}

function validBech32Checksum(prefix: string, words: number[]): boolean {
  const expanded = [
    ...[...prefix].map((character) => character.charCodeAt(0) >> 5),
    0,
    ...[...prefix].map((character) => character.charCodeAt(0) & 31)
  ]
  let state = 1
  for (const value of [...expanded, ...words]) {
    const top = state >>> 25
    state = ((state & 0x1ffffff) << 5) ^ value
    for (let index = 0; index < 5; index++) {
      if ((top >>> index) & 1) state ^= BECH32_GENERATORS[index]!
    }
  }
  return state === 1
}

function convertBitsStrict(words: number[], fromBits: number, toBits: number): number[] {
  let accumulator = 0
  let bits = 0
  const output: number[] = []
  const mask = (1 << toBits) - 1
  for (const word of words) {
    if (word < 0 || word >= 1 << fromBits) {
      throw teamPackError('INVALID_FORMAT', 'age X25519 私钥格式无效')
    }
    accumulator = (accumulator << fromBits) | word
    bits += fromBits
    while (bits >= toBits) {
      bits -= toBits
      output.push((accumulator >> bits) & mask)
    }
  }
  if (bits >= fromBits || ((accumulator << (toBits - bits)) & mask) !== 0) {
    throw teamPackError('INVALID_FORMAT', 'age X25519 私钥填充无效')
  }
  return output
}

const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

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
