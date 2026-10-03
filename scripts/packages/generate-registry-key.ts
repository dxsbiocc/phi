import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { registryKeyId } from '../../src/main/agent/packages/signature'

export const REGISTRY_PRIVATE_KEY_FILE = 'registry.key.pem'
export const REGISTRY_PUBLIC_KEY_FILE = 'registry.pub.json'

export interface GeneratedRegistryKey {
  keyId: string
  privateKeyPath: string
  publicKeyPath: string
}

export function generateRegistryKey(outDir: string): GeneratedRegistryKey {
  const output = resolve(outDir)
  const privateKeyPath = join(output, REGISTRY_PRIVATE_KEY_FILE)
  const publicKeyPath = join(output, REGISTRY_PUBLIC_KEY_FILE)
  if (existsSync(privateKeyPath) || existsSync(publicKeyPath)) {
    throw new Error(`refusing to overwrite registry signing key in ${output}`)
  }

  mkdirSync(output, { recursive: true })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
  })
  const keyId = registryKeyId(publicKey)
  writeFileSync(privateKeyPath, privateKey, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  writeFileSync(publicKeyPath, `${JSON.stringify({ version: 1, keyId, publicKey }, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o644
  })
  return { keyId, privateKeyPath, publicKeyPath }
}

function requiredArg(argv: string[], name: string): string {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

const entryScript = process.argv[1] ? resolve(process.argv[1]) : ''
if (entryScript === fileURLToPath(import.meta.url)) {
  try {
    const result = generateRegistryKey(requiredArg(process.argv.slice(2), '--out'))
    console.log(`Generated registry signing key ${result.keyId}.`)
    console.log(`Public key: ${result.publicKeyPath}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
