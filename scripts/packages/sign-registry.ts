import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { signRegistryIndex } from '../../src/main/agent/packages/signature'

export function signRegistry(registryDir: string, privateKeyFile: string): string {
  const registry = resolve(registryDir)
  const index = readFileSync(join(registry, 'index.json'))
  const privateKey = readFileSync(resolve(privateKeyFile))
  const signature = signRegistryIndex(index, privateKey)
  const signaturePath = join(registry, 'index.sig.json')
  writeFileSync(signaturePath, `${JSON.stringify(signature, null, 2)}\n`, 'utf8')
  return signaturePath
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
    const argv = process.argv.slice(2)
    const signaturePath = signRegistry(requiredArg(argv, '--registry'), requiredArg(argv, '--key'))
    const signature = JSON.parse(readFileSync(signaturePath, 'utf8')) as { keyId: string }
    console.log(`Signed registry with key ${signature.keyId}: ${signaturePath}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
