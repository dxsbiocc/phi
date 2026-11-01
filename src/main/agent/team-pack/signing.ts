import { createPublicKey, verify as verifyBytes } from 'node:crypto'

import {
  parseRegistrySignature,
  registryKeyId,
  signRegistryIndex,
  type RegistrySignature
} from '../packages/signature'
import { teamPackError } from './errors'

export function signTeamFile(data: Buffer, privateKey: string): Buffer {
  try {
    return Buffer.from(`${JSON.stringify(signRegistryIndex(data, privateKey), null, 2)}\n`)
  } catch {
    throw teamPackError('INVALID_FORMAT', '团队签名私钥无效')
  }
}

export function assertTrustedTeamKey(publicKey: string, expectedKeyId: string): void {
  if (!/^[a-f0-9]{16}$/.test(expectedKeyId)) {
    throw teamPackError('UNTRUSTED_TEAM_KEY', '团队公钥指纹格式无效')
  }
  try {
    if (registryKeyId(publicKey) !== expectedKeyId) {
      throw teamPackError('UNTRUSTED_TEAM_KEY', 'team.json 的团队公钥指纹不匹配')
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'UNTRUSTED_TEAM_KEY') {
      throw error
    }
    throw teamPackError('UNTRUSTED_TEAM_KEY', 'team.json 的团队公钥无效', error)
  }
}

export function verifyTeamFile(
  data: Buffer,
  signatureData: Buffer,
  publicKey: string,
  expectedKeyId: string
): RegistrySignature {
  let signature: RegistrySignature
  try {
    signature = parseRegistrySignature(JSON.parse(signatureData.toString('utf8')) as unknown)
  } catch (error) {
    throw teamPackError('BAD_SIGNATURE', '团队包签名文件格式无效', error)
  }
  if (signature.keyId !== expectedKeyId) {
    throw teamPackError('BAD_SIGNATURE', '团队包签名使用了未知公钥')
  }
  try {
    if (
      registryKeyId(publicKey) !== expectedKeyId ||
      !verifyBytes(
        null,
        data,
        createPublicKey(publicKey),
        Buffer.from(signature.signature, 'base64')
      )
    ) {
      throw teamPackError('BAD_SIGNATURE', '团队包签名验证失败')
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'BAD_SIGNATURE') throw error
    throw teamPackError('BAD_SIGNATURE', '团队包签名验证失败', error)
  }
  return signature
}
