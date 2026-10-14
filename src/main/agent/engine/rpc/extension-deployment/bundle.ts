import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { isAbsolute, join, posix, resolve } from 'node:path'
import type { PhiExtensionBundle, PhiExtensionFile } from './types'

const SOURCE_DIRECTORY = 'src/main/agent/engine/phi-extension'
const MAX_SOURCE_BYTES = 16 * 1024 * 1024

/** Explicit app paths avoid importing Electron in the Node-only deployment module. */
export function resolvePhiExtensionSourceRoot(options: {
  appPath: string
  resourcesPath: string
  isPackaged: boolean
}): string {
  const root = options.isPackaged
    ? join(options.resourcesPath, 'phi-extension')
    : join(options.appPath, SOURCE_DIRECTORY)
  if (!isAbsolute(root)) throw new Error('Phi extension source asset path must be absolute')
  return resolve(root)
}

// This deliberately supports only static source-module syntax. Dynamic loaders are
// rejected rather than guessed; the extension package is a small, trusted TS closure.
function moduleReferences(source: string): Array<{ path: string; typeOnly: boolean }> {
  const tokens: Array<{ text: string; string?: boolean }> = []
  const pattern =
    /\/\*[\s\S]*?\*\/|\/\/[^\n\r]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g
  for (const match of source.matchAll(pattern)) {
    const text = match[0]
    if (text.startsWith('//') || text.startsWith('/*')) continue
    if (text[0] === '`') {
      // A template's interpolated expression could hide a dynamic import.
      if (/\b(?:import|require|createRequire)\b/.test(text))
        throw new Error('Dynamic extension imports are unsupported')
      // Plain shell text legitimately contains `eval`; only interpolation code
      // can reference JavaScript's evaluator/constructor here.
      if (/\$\{[^}]*\b(?:eval|Function)\b/.test(text))
        throw new Error('Extension template loader references are unsupported')
      tokens.push({ text })
    } else if (text[0] === "'" || text[0] === '"') {
      // Escaped module names have no reason to occur in this controlled package.
      tokens.push({ text: text.slice(1, -1), string: true })
    } else tokens.push({ text })
  }
  const result: Array<{ path: string; typeOnly: boolean }> = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.string) continue
    if (['require', 'createRequire', 'eval', 'Function'].includes(token.text)) {
      throw new Error('Extension dynamic loader references and aliases are unsupported')
    }
    if (token.text !== 'import' && token.text !== 'export') continue
    if (tokens[i + 1]?.text === '(') throw new Error('Dynamic extension imports are unsupported')
    // `import type from ...` names a runtime default binding "type".
    // A comma (or import-equals) after that name also retains a runtime import.
    const typeOnly =
      tokens[i + 1]?.text === 'type' && !['from', ',', '='].includes(tokens[i + 2]?.text ?? '')
    if (tokens[i + 1]?.string) {
      result.push({ path: tokens[i + 1].text, typeOnly })
      continue
    }
    // A source import/export declaration ends at its specifier or first semicolon.
    // Without semicolons the following declaration is also a hard boundary.
    let bindings = 0
    for (let j = i + 1; j < tokens.length; j++) {
      const current = tokens[j]
      if (current.text === '{') bindings++
      if (current.text === '}') bindings--
      if (
        !bindings &&
        [';', 'import', 'export', 'function', 'const', 'interface'].includes(current.text)
      )
        break
      if (!bindings && current.text === 'from' && tokens[j + 1]?.string) {
        result.push({ path: tokens[j + 1].text, typeOnly })
        break
      }
    }
  }
  return result
}

export function hashPhiExtensionFiles(files: readonly PhiExtensionFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    hash.update(`${Buffer.byteLength(file.path)}:`).update(file.path)
    hash.update(`:${file.bytes.length}:`).update(file.bytes)
  }
  return hash.digest('hex')
}

export function validatePhiExtensionBundle(bundle: PhiExtensionBundle): void {
  if (!/^[a-f0-9]{64}$/.test(bundle.contentHash) || bundle.entryPoint !== 'rpc-entry.ts') {
    throw new Error('Invalid Phi extension bundle identity')
  }
  const paths = new Set<string>()
  let size = 0
  for (const file of bundle.files) {
    if (
      !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.ts$/.test(file.path) ||
      paths.has(file.path) ||
      createHash('sha256').update(file.bytes).digest('hex') !== file.sha256
    )
      throw new Error(`Invalid Phi extension bundle file: ${file.path}`)
    paths.add(file.path)
    size += file.bytes.length
  }
  if (
    size > MAX_SOURCE_BYTES ||
    !paths.has(bundle.entryPoint) ||
    hashPhiExtensionFiles(bundle.files) !== bundle.contentHash
  ) {
    throw new Error('Incomplete or changed Phi extension bundle')
  }
  for (const file of bundle.files) {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)
    for (const reference of moduleReferences(source)) {
      const specifier = reference.path
      if (['node:module', 'module', 'node:vm', 'vm'].includes(specifier)) {
        throw new Error(`Extension module loader dependency is unsupported: ${specifier}`)
      }
      if (isBuiltin(specifier)) continue
      if (
        reference.typeOnly &&
        ['@oh-my-pi/pi-coding-agent', '@oh-my-pi/pi-ai', '@oh-my-pi/pi-agent-core'].includes(
          specifier
        )
      )
        continue
      // OMP18.10.3 exposes this exact module through its compiled extension host.
      // Native stream integrity uses the host's canonical event stream class.
      if (specifier === '@oh-my-pi/pi-ai/utils/event-stream') continue
      // Child approvals use the host's shared router, not a bundled second SDK.
      // Keep the named export exact; neighboring paths are not part of this contract.
      if (specifier === '@oh-my-pi/pi-coding-agent/internal-urls') continue
      if (!specifier.startsWith('.') || /[\\\0\r\n]/.test(specifier)) {
        throw new Error(`Non-self-contained extension import in ${file.path}: ${specifier}`)
      }
      const target = posix.normalize(posix.join(posix.dirname(file.path), specifier))
      if (!paths.has(target) && !paths.has(`${target}.ts`) && !paths.has(`${target}/index.ts`)) {
        throw new Error(`Missing extension dependency in ${file.path}: ${specifier}`)
      }
    }
  }
}

/** Snapshot exact bytes before transfer so a development edit cannot change an active upload. */
export async function createPhiExtensionBundle(sourceRoot: string): Promise<PhiExtensionBundle> {
  if (!isAbsolute(sourceRoot)) throw new Error('Phi extension source directory must be absolute')
  const rootInfo = await lstat(sourceRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('Unsafe extension source directory')
  const root = await realpath(sourceRoot)
  const files: PhiExtensionFile[] = []
  let size = 0
  async function visit(relative: string): Promise<void> {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error(`Symbolic extension source entry: ${path}`)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.nlink !== 1 || info.size > MAX_SOURCE_BYTES - size)
            throw new Error(`Unsafe extension source file: ${path}`)
          const bytes = await handle.readFile()
          size += bytes.length
          files.push({ path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') })
        } finally {
          await handle.close()
        }
      } else throw new Error(`Unexpected extension source asset: ${path}`)
    }
  }
  await visit('')
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  const bundle: PhiExtensionBundle = {
    contentHash: hashPhiExtensionFiles(files),
    entryPoint: 'rpc-entry.ts',
    files
  }
  validatePhiExtensionBundle(bundle)
  return bundle
}
