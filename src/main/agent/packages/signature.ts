import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes
} from 'node:crypto'

export interface RegistrySignature {
  version: 1
  keyId: string
  signature: string
}

export interface TrustedRegistryKey {
  keyId: string
  publicKey: string
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function registryKeyId(publicKey: string | Buffer): string {
  return createHash('sha256').update(rawEd25519PublicKey(publicKey)).digest('hex').slice(0, 16)
}

export function publicKeyPem(privateKey: string | Buffer): string {
  const key = createPrivateKey(privateKey)
  assertEd25519Key(key.asymmetricKeyType)
  return createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString()
}

export function signRegistryIndex(
  index: string | Buffer,
  privateKey: string | Buffer
): RegistrySignature {
  const key = createPrivateKey(privateKey)
  assertEd25519Key(key.asymmetricKeyType)
  const publicKey = createPublicKey(key)
  return {
    version: 1,
    keyId: registryKeyId(publicKey.export({ format: 'pem', type: 'spki' })),
    signature: signBytes(null, Buffer.from(index), key).toString('base64')
  }
}

export function parseRegistrySignature(value: unknown): RegistrySignature {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.keyId !== 'string' ||
    !/^[a-f0-9]{16}$/.test(value.keyId) ||
    typeof value.signature !== 'string'
  ) {
    throw new Error('index.sig.json 格式无效')
  }
  const signature = decodeCanonicalBase64(value.signature)
  if (signature.length !== 64) throw new Error('index.sig.json 签名长度无效')
  return { version: 1, keyId: value.keyId, signature: value.signature }
}

export function verifyRegistryIndex(
  index: string | Buffer,
  signature: RegistrySignature,
  trustedKeys: readonly TrustedRegistryKey[]
): 'official' | 'imported' {
  const trustedKey = trustedKeys.find((candidate) => candidate.keyId === signature.keyId)
  if (!trustedKey) return 'imported'

  let actualKeyId: string
  let publicKey: ReturnType<typeof createPublicKey>
  try {
    publicKey = createPublicKey(trustedKey.publicKey)
    assertEd25519Key(publicKey.asymmetricKeyType)
    actualKeyId = registryKeyId(trustedKey.publicKey)
  } catch (error) {
    throw new Error(`内置信任密钥 ${signature.keyId} 无效: ${errorMessage(error)}`)
  }
  if (actualKeyId !== trustedKey.keyId) {
    throw new Error(`内置信任密钥 ${trustedKey.keyId} 的 keyId 不匹配`)
  }
  if (
    !verifyBytes(null, Buffer.from(index), publicKey, decodeCanonicalBase64(signature.signature))
  ) {
    throw new Error('注册表签名验证失败，index.json 可能已被篡改')
  }
  return 'official'
}

function rawEd25519PublicKey(publicKey: string | Buffer): Buffer {
  const key = createPublicKey(publicKey)
  assertEd25519Key(key.asymmetricKeyType)
  const spki = key.export({ format: 'der', type: 'spki' })
  if (
    spki.length !== ED25519_SPKI_PREFIX.length + 32 ||
    !spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new Error('Ed25519 公钥编码无效')
  }
  return spki.subarray(ED25519_SPKI_PREFIX.length)
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('index.sig.json 签名不是有效 base64')
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) throw new Error('index.sig.json 签名不是有效 base64')
  return decoded
}

function assertEd25519Key(type: string | undefined): void {
  if (type !== 'ed25519') throw new Error('注册表签名密钥必须是 Ed25519 密钥')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
