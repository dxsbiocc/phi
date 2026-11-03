import { createHash } from 'node:crypto'
import {
  chmodSync,
  constants,
  copyFileSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { globSync } from 'glob'

export interface PrepareIsolatedHomeOptions {
  sourceHome?: string
  destinationHome?: string
  tempRoot?: string
}

export interface PreparedIsolatedHome {
  homeDir: string
  agentDir: string
  copiedIdentityFiles: number
  missingIdentityFiles: number
  skippedSymlinks: number
  sshConfigCopied: boolean
}

interface CopyStats {
  skippedSymlinks: number
}

interface IdentityCopyContext {
  sourceHome: string
  destinationHome: string
  copied: Map<string, string>
  missing: Set<string>
}

const ISOLATED_HOME_PREFIX = 'phi-gui-e2e-'
const STALE_HOME_AGE_MS = 60 * 60 * 1_000

export function sweepStaleIsolatedHomes(
  tempRoot: string = tmpdir(),
  nowMs: number = Date.now()
): string[] {
  const root = resolve(tempRoot)
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }

  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(ISOLATED_HOME_PREFIX)) continue
    const candidate = join(root, entry.name)
    try {
      const home = lstatSync(candidate)
      const marker = lstatSync(join(candidate, '.phi'))
      if (!home.isDirectory() || !marker.isDirectory()) continue
      if (home.mtimeMs >= nowMs - STALE_HOME_AGE_MS) continue
      rmSync(candidate, { recursive: true, force: true })
      removed.push(candidate)
    } catch {
      // Missing, unreadable, or concurrently changed entries are not safe sweep targets.
    }
  }
  return removed
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(resolve(parent), resolve(candidate))
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function assertFreshDestination(sourceHome: string, destinationHome: string): void {
  if (isWithin(sourceHome, destinationHome)) {
    throw new Error('Isolated HOME must not be inside the source HOME')
  }
  if (existsSync(destinationHome) && readdirSync(destinationHome).length > 0) {
    throw new Error('Isolated HOME must be empty')
  }
  mkdirSync(destinationHome, { recursive: true, mode: 0o700 })
  chmodSync(destinationHome, 0o700)
}

function copyProfileTree(source: string, destination: string, stats: CopyStats): void {
  if (!existsSync(source)) {
    mkdirSync(destination, { recursive: true, mode: 0o700 })
    return
  }
  const sourceInfo = lstatSync(source)
  if (sourceInfo.isSymbolicLink()) {
    stats.skippedSymlinks += 1
    return
  }
  if (sourceInfo.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: (sourceInfo.mode | 0o700) & 0o777 })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      copyProfileTree(join(source, entry.name), join(destination, entry.name), stats)
    }
    return
  }
  if (!sourceInfo.isFile()) return
  mkdirSync(dirname(destination), { recursive: true })
  // A copy-on-write clone: the profile holds gigabytes of runtimes and caches.
  copyFileSync(source, destination, constants.COPYFILE_FICLONE)
  chmodSync(destination, (sourceInfo.mode | 0o600) & 0o777)
}

function copyPhiProfile(sourceHome: string, destinationHome: string, stats: CopyStats): void {
  const source = join(sourceHome, '.phi')
  const destination = join(destinationHome, '.phi')
  if (!existsSync(source)) {
    mkdirSync(destination, { recursive: true, mode: 0o700 })
    return
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'logs') continue
    copyProfileTree(join(source, entry.name), join(destination, entry.name), stats)
  }
}

function directiveWords(line: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const character of line) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\') escaped = true
    else if (quote && character === quote) quote = null
    else if (quote) current += character
    else if (character === '"' || character === "'") quote = character
    else if (character === '#') break
    else if (/\s/.test(character)) {
      if (current) words.push(current)
      current = ''
    } else current += character
  }
  if (current) words.push(current)
  return words
}

function directive(line: string): { name: string; values: string[] } | undefined {
  const words = directiveWords(line)
  const first = words.shift()
  if (!first) return undefined
  const separator = first.indexOf('=')
  if (separator < 0) return { name: first.toLowerCase(), values: words }
  return {
    name: first.slice(0, separator).toLowerCase(),
    values: [first.slice(separator + 1), ...words].filter(Boolean)
  }
}

function sourceIdentityPath(reference: string, sourceHome: string): string | undefined {
  const expanded = reference
    .replace(/^~(?=\/|$)/, sourceHome)
    .replace(/^%d(?=\/|$)/, sourceHome)
    .replace(/^\$HOME(?=\/|$)/, sourceHome)
  if (/%[A-Za-z%]/.test(expanded) || /[\r\n\0]/.test(expanded)) return undefined
  return resolve(isAbsolute(expanded) ? expanded : join(sourceHome, expanded))
}

function isolatedIdentityRelativePath(sourcePath: string, sourceHome: string): string {
  const sourceSshDir = join(sourceHome, '.ssh')
  if (isWithin(sourceSshDir, sourcePath)) return join('.ssh', relative(sourceSshDir, sourcePath))
  const digest = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12)
  const safeName = basename(sourcePath).replace(/[^A-Za-z0-9._-]/g, '_') || 'identity'
  return join('.ssh', 'identities', `${digest}-${safeName}`)
}

function copyIdentity(reference: string, context: IdentityCopyContext): string {
  const sourcePath = sourceIdentityPath(reference, context.sourceHome)
  const syntheticSource = sourcePath ?? `unresolved:${reference}`
  const cached = context.copied.get(syntheticSource)
  if (cached) return cached
  const relativePath = isolatedIdentityRelativePath(syntheticSource, context.sourceHome)
  const destinationPath = join(context.destinationHome, relativePath)
  const isolatedReference = `~/${relativePath.split(sep).join('/')}`
  context.copied.set(syntheticSource, isolatedReference)
  if (!sourcePath || !existsSync(sourcePath)) {
    context.missing.add(syntheticSource)
    return isolatedReference
  }
  try {
    if (!statSync(sourcePath).isFile()) throw new Error('not a regular file')
    mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 })
    copyFileSync(realpathSync(sourcePath), destinationPath)
    chmodSync(destinationPath, 0o600)
  } catch {
    context.missing.add(syntheticSource)
  }
  return isolatedReference
}

function sshWord(value: string): string {
  return /[\s#'"\\]/.test(value) ? `"${value.replace(/["\\]/g, '\\$&')}"` : value
}

function includePaths(pattern: string, sourceHome: string): string[] {
  const expanded = pattern.replace(/^~(?=\/|$)/, sourceHome).replace(/^%d(?=\/|$)/, sourceHome)
  if (/%[A-Za-z%]/.test(expanded) || /[\r\n\0]/.test(expanded)) return []
  const absolute = isAbsolute(expanded) ? expanded : join(sourceHome, '.ssh', expanded)
  return globSync(absolute, { absolute: true, nodir: true }).sort()
}

function flattenSshConfig(
  configPath: string,
  context: IdentityCopyContext,
  visited: Set<string>
): string[] {
  let canonical: string
  try {
    canonical = realpathSync(configPath)
    if (visited.has(canonical) || visited.size >= 64 || statSync(canonical).size > 1024 * 1024)
      return []
  } catch {
    return []
  }
  visited.add(canonical)
  const lines = readFileSync(canonical, 'utf8')
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
  return lines.flatMap((line): string[] => {
    const parsed = directive(line)
    if (parsed?.name === 'include') {
      return parsed.values.flatMap((pattern) =>
        includePaths(pattern, context.sourceHome).flatMap((path) =>
          flattenSshConfig(path, context, visited)
        )
      )
    }
    if (parsed?.name !== 'identityfile' || parsed.values.length === 0) {
      return [line.split(context.sourceHome).join('~')]
    }
    return [`  IdentityFile ${sshWord(copyIdentity(parsed.values[0], context))}`]
  })
}

function copySshConfig(context: IdentityCopyContext): boolean {
  const sourceConfig = join(context.sourceHome, '.ssh', 'config')
  if (!existsSync(sourceConfig)) return false
  const destinationConfig = join(context.destinationHome, '.ssh', 'config')
  mkdirSync(dirname(destinationConfig), { recursive: true, mode: 0o700 })
  const flattened = flattenSshConfig(sourceConfig, context, new Set())
  writeFileSync(destinationConfig, `${flattened.join('\n')}\n`, { mode: 0o600 })
  chmodSync(destinationConfig, 0o600)
  return true
}

function rewritePhiHostIdentities(context: IdentityCopyContext): void {
  const path = join(context.destinationHome, '.phi', 'ssh-hosts.json')
  if (!existsSync(path)) return
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(value)) return
    const profiles = value.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item
      const profile = item as Record<string, unknown>
      return typeof profile.identityFile === 'string' && profile.identityFile
        ? { ...profile, identityFile: copyIdentity(profile.identityFile, context) }
        : profile
    })
    writeFileSync(path, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
  } catch {
    // Preserve an unreadable copied profile; the app will report its existing validation error.
  }
}

export function isolatedHomeEnvironment(
  homeDir: string,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...base,
    HOME: homeDir,
    USERPROFILE: homeDir,
    PI_CODING_AGENT_DIR: join(homeDir, '.phi')
  }
}

export function prepareIsolatedHome(
  options: PrepareIsolatedHomeOptions = {}
): PreparedIsolatedHome {
  const sourceHome = resolve(options.sourceHome ?? homedir())
  const generatedHome = options.destinationHome === undefined
  const homeDir = resolve(
    options.destinationHome ?? mkdtempSync(join(options.tempRoot ?? tmpdir(), 'phi-gui-e2e-'))
  )
  const destinationExisted = existsSync(homeDir)
  let destinationPrepared = false
  try {
    assertFreshDestination(sourceHome, homeDir)
    destinationPrepared = true
    const stats: CopyStats = { skippedSymlinks: 0 }
    copyPhiProfile(sourceHome, homeDir, stats)
    const identityContext: IdentityCopyContext = {
      sourceHome,
      destinationHome: homeDir,
      copied: new Map(),
      missing: new Set()
    }
    const sshConfigCopied = copySshConfig(identityContext)
    rewritePhiHostIdentities(identityContext)
    return {
      homeDir,
      agentDir: join(homeDir, '.phi'),
      copiedIdentityFiles: identityContext.copied.size - identityContext.missing.size,
      missingIdentityFiles: identityContext.missing.size,
      skippedSymlinks: stats.skippedSymlinks,
      sshConfigCopied
    }
  } catch (error) {
    if (generatedHome || destinationPrepared || !destinationExisted) {
      rmSync(homeDir, { recursive: true, force: true })
    }
    throw error
  }
}
