/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Fails when electron-builder.yml's `asarUnpack` misses anything the OMP worker
// needs on disk at runtime (see scripts/build/omp-worker-closure.mjs). bun
// runs the worker and cannot read inside app.asar, so a miss means the
// packaged app cannot start a chat turn.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { collectOmpWorkerPackageDirs, ompWorkerOutputFiles } from './build/omp-worker-closure.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Directories the OMP copy plugin writes into, checked as built when present.
const BUILT_WORKER_DIRS = ['out/main/agent', 'out/shared']

export function globToRegExp(glob) {
  let pattern = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*' && glob[index + 1] === '*') {
      const slashFollows = glob[index + 2] === '/'
      pattern += slashFollows ? '(?:.*/)?' : '.*'
      index += slashFollows ? 2 : 1
    } else if (char === '*') {
      pattern += '[^/]*'
    } else if (char === '?') {
      pattern += '[^/]'
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${pattern}$`)
}

export function uncoveredPaths(globs, paths) {
  const matchers = globs.map(globToRegExp)
  return paths.filter((filePath) => !matchers.some((matcher) => matcher.test(filePath)))
}

export function readAsarUnpackGlobs(root = repoRoot) {
  const config = parse(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'))
  const globs = config?.asarUnpack
  if (!Array.isArray(globs)) throw new Error('electron-builder.yml has no asarUnpack list')
  return globs
}

function listFiles(root, dir) {
  const absolute = path.join(root, dir)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
    )
}

/** Paths that must land in app.asar.unpacked for the worker to run. */
export function requiredUnpackPaths(root = repoRoot) {
  return [
    // readAppVersion() resolves ../../../package.json from out/main/agent/.
    'package.json',
    ...ompWorkerOutputFiles(root),
    ...BUILT_WORKER_DIRS.flatMap((dir) => listFiles(root, dir)),
    ...collectOmpWorkerPackageDirs(root).map((dir) => `${dir}/package.json`)
  ]
}

export function checkAsarUnpack(root = repoRoot) {
  return [...new Set(uncoveredPaths(readAsarUnpackGlobs(root), requiredUnpackPaths(root)))]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const missing = checkAsarUnpack()
  if (missing.length > 0) {
    console.error('electron-builder.yml asarUnpack misses files the OMP worker needs at runtime:')
    for (const filePath of missing) console.error(`  - ${filePath}`)
    process.exit(1)
  }
  console.log('asarUnpack covers the OMP worker closure.')
}
