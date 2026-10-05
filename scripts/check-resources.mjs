/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Untracked files under resources/ that lint accepts. Anything else is a run
// leftover and must not ship. `.DS_Store` is macOS noise (also excluded from
// `resources/runtime/micromamba/` holds binaries from `npm run runtime:fetch`;
// `resources/office/officecli/` holds the OfficeCLI binary from `bun run office:fetch`.
const ALLOWED_UNTRACKED_RESOURCES = {
  basenames: new Set(['.DS_Store']),
  paths: new Set(),
  prefixes: ['resources/runtime/micromamba/', 'resources/office/officecli/']
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
