/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Untracked files under resources/ that lint accepts. Anything else is a run
// leftover and must not ship. `.DS_Store` is macOS noise.
// `resources/runtime/micromamba/` holds binaries from `bun run runtime:fetch`;
// `resources/runtime/bun/` holds binaries from `bun run bun:fetch`;
// `resources/office/officecli/` is allowed only for a developer's explicit
// `bun run office:fetch`; electron-builder excludes it from every installer.
// `resources/remote-helper/` holds cross-compiled output from `bun run build:helper`.
const ALLOWED_UNTRACKED_RESOURCES = {
  basenames: new Set(['.DS_Store']),
  paths: new Set(['resources/README.md']),
  prefixes: [
    'resources/runtime/micromamba/',
    'resources/runtime/bun/',
    'resources/office/officecli/',
    'resources/remote-helper/'
  ]
}

const MAX_LISTED_OFFENDING_PATHS = 50

function normalizedResourcePath(filePath) {
  return filePath.split('\\').join('/')
}

function isAllowedUntrackedResource(filePath) {
  const normalized = normalizedResourcePath(filePath)
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1)
  return (
    ALLOWED_UNTRACKED_RESOURCES.basenames.has(basename) ||
    ALLOWED_UNTRACKED_RESOURCES.paths.has(normalized) ||
    ALLOWED_UNTRACKED_RESOURCES.prefixes.some((prefix) => normalized.startsWith(prefix))
  )
}

export function offendingResourcePaths(paths) {
  return paths.filter((filePath) => !isAllowedUntrackedResource(filePath))
}

// Distributable sources belong to phi-packages. These are the only source
// roots retained in Phi; Office's licensed plugin is a private exception.
const PHI_RESOURCE_FILES = new Set(['resources/README.md', 'resources/icon.png'])
const PHI_RESOURCE_PARENTS = new Set(['resources/skills', 'resources/plugins'])
const PHI_RESOURCE_ROOTS = [
  'resources/agents',
  'resources/icons',
  'resources/office',
  'resources/palettes',
  'resources/remote-helper',
  'resources/runtime',
  'resources/skills/create-wrapper',
  'resources/plugins/office'
]

export function misplacedPhiResourcePaths(paths) {
  return paths.filter((filePath) => {
    const normalized = normalizedResourcePath(filePath)
    return !(
      path.posix.basename(normalized) === '.DS_Store' ||
      PHI_RESOURCE_FILES.has(normalized) ||
      PHI_RESOURCE_PARENTS.has(normalized) ||
      PHI_RESOURCE_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`))
    )
  })
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidMirrorPrefix(value) {
  if (typeof value !== 'string' || !value.startsWith('https://') || !value.endsWith('/')) {
    return false
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

export function runtimeMirrorPrefixErrors(manifest) {
  if (!isObject(manifest)) return []
  const errors = []
  for (const [runtimeName, runtime] of Object.entries(manifest)) {
    if (!isObject(runtime) || !isObject(runtime.platforms)) continue
    for (const [platformName, platform] of Object.entries(runtime.platforms)) {
      if (!isObject(platform) || !Object.hasOwn(platform, 'mirrorPrefixes')) continue
      const path = `${runtimeName}.platforms.${platformName}.mirrorPrefixes`
      if (!Array.isArray(platform.mirrorPrefixes)) {
        errors.push(`${path} must be a string array`)
        continue
      }
      platform.mirrorPrefixes.forEach((prefix, index) => {
        if (!isValidMirrorPrefix(prefix)) {
          errors.push(`${path}[${index}] must be an HTTPS URL without userinfo and ending in /`)
        }
      })
    }
  }
  return errors
}

function readRuntimeManifest() {
  return JSON.parse(readFileSync(path.join(repoRoot, 'resources/runtime/manifest.json'), 'utf8'))
}

function listPhiResourceEntries() {
  const roots = readdirSync(path.join(repoRoot, 'resources'), { withFileTypes: true })
  return roots.flatMap((entry) => {
    const relative = `resources/${entry.name}`
    if (!entry.isDirectory() || !PHI_RESOURCE_PARENTS.has(relative)) return [relative]
    return [
      relative,
      ...readdirSync(path.join(repoRoot, relative)).map((child) => `${relative}/${child}`)
    ]
  })
}

function textOf(value) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

function isGitUnavailable(error) {
  if (typeof error !== 'object' || error === null) return false
  if ('code' in error && error.code === 'ENOENT') return true
  const stderrText = 'stderr' in error ? textOf(error.stderr) : ''
  const message = 'message' in error ? textOf(error.message) : ''
  return stderrText.includes('not a git repository') || message.includes('not a git repository')
}

function gitLines(args) {
  const output = execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    // Capture stderr. The default forwards it, which would print git's
    // "not a git repository" next to this script's own warning.
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return output.split(/\r?\n/).filter((line) => line.length > 0)
}

function listUntrackedResourcePaths() {
  return [
    ...gitLines(['ls-files', '--others', '--exclude-standard', 'resources']),
    ...gitLines(['ls-files', '--others', '--ignored', '--exclude-standard', 'resources'])
  ]
}

function main() {
  const mirrorErrors = runtimeMirrorPrefixErrors(readRuntimeManifest())
  if (mirrorErrors.length > 0) {
    console.error('Invalid runtime mirror prefixes:')
    for (const error of mirrorErrors) console.error(`- ${error}`)
    process.exit(1)
  }
  const misplaced = misplacedPhiResourcePaths(listPhiResourceEntries())
  if (misplaced.length > 0) {
    console.error('Content sources outside Phi core resources (maintain them in phi-packages):')
    for (const filePath of misplaced.slice(0, MAX_LISTED_OFFENDING_PATHS)) {
      console.error(`- ${filePath}`)
    }
    process.exit(1)
  }
  let paths
  try {
    paths = listUntrackedResourcePaths()
  } catch (error) {
    if (isGitUnavailable(error)) {
      console.warn(
        'check-resources: skipping because git is unavailable or this directory is not a git work tree.'
      )
      process.exit(0)
    }
    throw error
  }

  const offending = offendingResourcePaths(paths)
  if (offending.length === 0) return

  const shown = offending.slice(0, MAX_LISTED_OFFENDING_PATHS)
  const rest = offending.length - shown.length
  console.error('Untracked files under resources/:')
  for (const filePath of shown) {
    console.error(`- ${filePath}`)
  }
  if (rest > 0) {
    console.error(`and ${rest} more`)
  }
  console.error('These are run leftovers and should be deleted.')
  process.exit(1)
}

const entry = process.argv[1]
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main()
}
