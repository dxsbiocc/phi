import { identityToRecipient } from 'age-encryption'

import { publicKeyPem, registryKeyId } from '../packages/signature'
import { isTeamPackError, teamPackError } from './errors'
import {
  createAgeX25519Keys,
  createMemberSigningKeys,
  recipientForAgeIdentity,
  type MemberKeys,
  type TeamKeys
} from './keys'
import {
  assertTeamId,
  assertTeamName,
  assertX25519Identity,
  assertX25519Recipient
} from './validation'

export interface TeamPrivateKeyMaterial {
  version: 2
  type: 'phi-team-signing-private-key'
  teamId: string
  keyId: string
  privateKey: string
  submissionIdentity: string
  submissionRecipient: string
}

export interface MemberPrivateKeyMaterial {
  version: 2
  type: 'phi-team-member-identity'
  recipient: string
  identity: string
  signingPublicKey: string
  signingPrivateKey: string
  signingKeyId: string
}

export type ParsedTeamPrivateKeyMaterial = TeamPrivateKeyMaterial & { upgraded: boolean }
export type ParsedMemberPrivateKeyMaterial = MemberPrivateKeyMaterial & { upgraded: boolean }

export function validateTeamKeys(value: unknown): asserts value is TeamKeys {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'teamId',
      'name',
      'publicKey',
      'privateKey',
      'keyId',
      'submissionIdentity',
      'submissionRecipient'
    ]) ||
    value.version !== 2 ||
    typeof value.publicKey !== 'string' ||
    typeof value.privateKey !== 'string' ||
    typeof value.keyId !== 'string' ||
    typeof value.submissionIdentity !== 'string' ||
    typeof value.submissionRecipient !== 'string'
  ) {
    throw teamPackError('INVALID_FORMAT', '团队密钥格式无效')
  }
  try {
    assertTeamId(value.teamId)
    assertTeamName(value.name)
    if (
      !/^[a-f0-9]{16}$/.test(value.keyId) ||
      publicKeyPem(value.privateKey) !== value.publicKey ||
      registryKeyId(value.publicKey) !== value.keyId
    ) {
      throw new Error('key mismatch')
    }
    assertX25519Identity(value.submissionIdentity)
    assertX25519Recipient(value.submissionRecipient)
    if (recipientForAgeIdentity(value.submissionIdentity) !== value.submissionRecipient) {
      throw new Error('submission recipient mismatch')
    }
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('INVALID_FORMAT', '团队密钥格式无效', error)
  }
}

export async function validatedMemberKeys(value: unknown): Promise<MemberKeys> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'identity',
      'recipient',
      'signingPublicKey',
      'signingPrivateKey',
      'signingKeyId'
    ]) ||
    value.version !== 2 ||
    typeof value.signingPublicKey !== 'string' ||
    typeof value.signingPrivateKey !== 'string' ||
    typeof value.signingKeyId !== 'string'
  ) {
    throw teamPackError('INVALID_FORMAT', '成员密钥格式无效')
  }
  try {
    assertX25519Identity(value.identity)
    assertX25519Recipient(value.recipient)
    if ((await identityToRecipient(value.identity)) !== value.recipient) {
      throw new Error('recipient mismatch')
    }
    if (
      publicKeyPem(value.signingPrivateKey) !== value.signingPublicKey ||
      registryKeyId(value.signingPublicKey) !== value.signingKeyId ||
      !/^[a-f0-9]{16}$/.test(value.signingKeyId)
    ) {
      throw new Error('signing key mismatch')
    }
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('INVALID_FORMAT', '成员密钥格式无效', error)
  }
  return {
    version: 2,
    identity: value.identity,
    recipient: value.recipient,
    signingPublicKey: value.signingPublicKey,
    signingPrivateKey: value.signingPrivateKey,
    signingKeyId: value.signingKeyId
  }
}

export function normalizeTeamKeys(value: unknown): TeamKeys {
  if (isRecord(value) && value.version === 1) {
    if (!hasExactKeys(value, ['version', 'teamId', 'name', 'publicKey', 'privateKey', 'keyId'])) {
      throw teamPackError('INVALID_FORMAT', '团队密钥格式无效')
    }
    const inbox = createAgeX25519Keys()
    const upgraded = {
      ...value,
      version: 2 as const,
      submissionIdentity: inbox.identity,
      submissionRecipient: inbox.recipient
    }
    validateTeamKeys(upgraded)
    return upgraded
  }
  validateTeamKeys(value)
  return value
}

export async function normalizeMemberKeys(value: unknown): Promise<MemberKeys> {
  if (isRecord(value) && value.version === 1) {
    if (!hasExactKeys(value, ['version', 'identity', 'recipient'])) {
      throw teamPackError('INVALID_FORMAT', '成员密钥格式无效')
    }
    return validatedMemberKeys({ ...value, version: 2 as const, ...createMemberSigningKeys() })
  }
  return validatedMemberKeys(value)
}

// eslint-disable-next-line complexity -- versioned migration validates every secret-bearing field independently
export function parseTeamPrivateKeyMaterial(value: unknown): ParsedTeamPrivateKeyMaterial {
  if (
    isRecord(value) &&
    hasExactKeys(value, ['version', 'type', 'teamId', 'keyId', 'privateKey']) &&
    value.version === 1 &&
    value.type === 'phi-team-signing-private-key' &&
    typeof value.keyId === 'string' &&
    typeof value.privateKey === 'string'
  ) {
    assertTeamId(value.teamId)
    if (!/^[a-f0-9]{16}$/.test(value.keyId)) invalidTeamPrivateMaterial()
    const inbox = createAgeX25519Keys()
    return {
      version: 2,
      type: 'phi-team-signing-private-key',
      teamId: value.teamId,
      keyId: value.keyId,
      privateKey: value.privateKey,
      submissionIdentity: inbox.identity,
      submissionRecipient: inbox.recipient,
      upgraded: true
    }
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'type',
      'teamId',
      'keyId',
      'privateKey',
      'submissionIdentity',
      'submissionRecipient'
    ]) ||
    value.version !== 2 ||
    value.type !== 'phi-team-signing-private-key' ||
    typeof value.keyId !== 'string' ||
    typeof value.privateKey !== 'string' ||
    typeof value.submissionIdentity !== 'string' ||
    typeof value.submissionRecipient !== 'string'
  ) {
    invalidTeamPrivateMaterial()
  }
  assertTeamId(value.teamId)
  if (!/^[a-f0-9]{16}$/.test(value.keyId)) invalidTeamPrivateMaterial()
  assertX25519Identity(value.submissionIdentity)
  assertX25519Recipient(value.submissionRecipient)
  return {
    version: 2,
    type: 'phi-team-signing-private-key',
    teamId: value.teamId,
    keyId: value.keyId,
    privateKey: value.privateKey,
    submissionIdentity: value.submissionIdentity,
    submissionRecipient: value.submissionRecipient,
    upgraded: false
  }
}

export function parseMemberPrivateKeyMaterial(value: unknown): ParsedMemberPrivateKeyMaterial {
  if (
    isRecord(value) &&
    hasExactKeys(value, ['version', 'type', 'recipient', 'identity']) &&
    value.version === 1 &&
    value.type === 'phi-team-member-identity'
  ) {
    assertX25519Recipient(value.recipient)
    assertX25519Identity(value.identity)
    return {
      version: 2,
      type: 'phi-team-member-identity',
      recipient: value.recipient,
      identity: value.identity,
      ...createMemberSigningKeys(),
      upgraded: true
    }
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'type',
      'recipient',
      'identity',
      'signingPublicKey',
      'signingPrivateKey',
      'signingKeyId'
    ]) ||
    value.version !== 2 ||
    value.type !== 'phi-team-member-identity' ||
    typeof value.signingPublicKey !== 'string' ||
    typeof value.signingPrivateKey !== 'string' ||
    typeof value.signingKeyId !== 'string'
  ) {
    throw teamPackError('INVALID_FORMAT', '成员身份密文格式无效')
  }
  assertX25519Recipient(value.recipient)
  assertX25519Identity(value.identity)
  return {
    version: 2,
    type: 'phi-team-member-identity',
    recipient: value.recipient,
    identity: value.identity,
    signingPublicKey: value.signingPublicKey,
    signingPrivateKey: value.signingPrivateKey,
    signingKeyId: value.signingKeyId,
    upgraded: false
  }
}

function invalidTeamPrivateMaterial(): never {
  throw teamPackError('INVALID_FORMAT', '团队签名私钥密文格式无效')
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
