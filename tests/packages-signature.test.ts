import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { readRegistry } from '../src/main/agent/packages/registry'
import {
  registryKeyId,
  signRegistryIndex,
  type TrustedRegistryKey
} from '../src/main/agent/packages/signature'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function temporaryDir(name = 'phi-registry-signature-'): string {
  const root = mkdtempSync(join(tmpdir(), name))
  roots.push(root)
  return root
}

function writeIndex(registryDir: string): Buffer {
  mkdirSync(registryDir, { recursive: true })
  const bytes = Buffer.from(
    `${JSON.stringify(
      { schemaVersion: 1, generatedAt: '2026-10-02T00:00:00.000Z', packages: [] },
      null,
      2
    )}\n`
  )
  writeFileSync(join(registryDir, 'index.json'), bytes)
  return bytes
}

function keyPair(): {
  privateKey: string
  publicKey: string
  trustedKey: TrustedRegistryKey
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
  })
  return {
    privateKey,
    publicKey,
    trustedKey: { keyId: registryKeyId(publicKey), publicKey }
  }
}

function signIndex(registryDir: string, index: Buffer, privateKey: string): void {
  writeFileSync(
    join(registryDir, 'index.sig.json'),
    `${JSON.stringify(signRegistryIndex(index, privateKey), null, 2)}\n`
  )
}

test('computes keyId from the raw 32-byte Ed25519 public key', () => {
  const { publicKey } = keyPair()
  const der = Buffer.from(
    // Node emits RFC 8410 SubjectPublicKeyInfo for Ed25519.
    createPublicKey(publicKey).export({ format: 'der', type: 'spki' })
  )
  assert.equal(der.length, 44)
  assert.equal(
    registryKeyId(publicKey),
    createHash('sha256').update(der.subarray(12)).digest('hex').slice(0, 16)
  )
})

test('reads builtin, valid official, unsigned, and unknown-key registries at the right tier', () => {
  const registryDir = temporaryDir()
  const index = writeIndex(registryDir)
  const known = keyPair()

  assert.equal(readRegistry(registryDir).trust, 'imported')
  assert.equal(readRegistry(registryDir, { builtin: true }).trust, 'builtin')

  signIndex(registryDir, index, known.privateKey)
  assert.equal(readRegistry(registryDir, { trustedKeys: [known.trustedKey] }).trust, 'official')

  const unknown = keyPair()
  assert.equal(readRegistry(registryDir, { trustedKeys: [unknown.trustedKey] }).trust, 'imported')
})

test('rejects a known-key signature after index.json is tampered with', () => {
  const registryDir = temporaryDir()
  const index = writeIndex(registryDir)
  const known = keyPair()
  signIndex(registryDir, index, known.privateKey)
  writeFileSync(
    join(registryDir, 'index.json'),
    index.toString('utf8').replace('2026-10-02', '2026-10-03')
  )

  assert.throws(
    () => readRegistry(registryDir, { trustedKeys: [known.trustedKey] }),
    /签名验证失败.*篡改/
  )
})

test('rejects malformed index.sig.json with a clear Chinese error', async (context) => {
  for (const [name, value] of [
    ['invalid JSON', '{'],
    ['invalid fields', JSON.stringify({ version: 1, keyId: 'no', signature: '***' })]
  ]) {
    await context.test(name, () => {
      const registryDir = temporaryDir()
      writeIndex(registryDir)
      writeFileSync(join(registryDir, 'index.sig.json'), value)
      assert.throws(() => readRegistry(registryDir), /注册表签名文件被拒绝/)
    })
  }
})

test('registry keygen and sign CLIs round-trip without exposing or overwriting the private key', () => {
  const root = temporaryDir('phi-registry-signing-cli-')
  const keysDir = join(root, 'keys')
  const registryDir = join(root, 'registry')
  writeIndex(registryDir)

  const keygenOutput = execFileSync('bun', ['run', 'registry:keygen', '--', '--out', keysDir], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  const privateKeyPath = join(keysDir, 'registry.key.pem')
  const publicKeyPath = join(keysDir, 'registry.pub.json')
  const privateKey = readFileSync(privateKeyPath, 'utf8')
  const publicDocument = JSON.parse(readFileSync(publicKeyPath, 'utf8')) as TrustedRegistryKey & {
    version: 1
  }
  assert.equal(statSync(privateKeyPath).mode & 0o777, 0o600)
  assert.equal(publicDocument.keyId, registryKeyId(publicDocument.publicKey))
  assert.equal(keygenOutput.includes(privateKey), false)

  assert.throws(
    () =>
      execFileSync('bun', ['run', 'registry:keygen', '--', '--out', keysDir], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe'
      }),
    /Command failed/
  )
  assert.equal(readFileSync(privateKeyPath, 'utf8'), privateKey)

  execFileSync(
    'bun',
    ['run', 'registry:sign', '--', '--registry', registryDir, '--key', privateKeyPath],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  assert.equal(readRegistry(registryDir, { trustedKeys: [publicDocument] }).trust, 'official')
})

test('registry:build --sign-key signs the exact generated index bytes', () => {
  const root = temporaryDir('phi-registry-build-signing-')
  const keysDir = join(root, 'keys')
  const registryDir = join(root, 'registry')
  execFileSync('bun', ['run', 'registry:keygen', '--', '--out', keysDir], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  execFileSync(
    'bun',
    [
      'run',
      'registry:build',
      '--',
      '--out',
      registryDir,
      '--sign-key',
      join(keysDir, 'registry.key.pem')
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  const publicDocument = JSON.parse(
    readFileSync(join(keysDir, 'registry.pub.json'), 'utf8')
  ) as TrustedRegistryKey
  assert.equal(readRegistry(registryDir, { trustedKeys: [publicDocument] }).trust, 'official')
})
