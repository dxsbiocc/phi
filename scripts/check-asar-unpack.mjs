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
const REQUIRED_EXTRA_RESOURCE_MAPPINGS = [
  { section: 'extraResources', from: 'resources/remote-helper', to: 'remote-helper' },
  {
    section: 'mac.extraResources',
    from: 'resources/runtime/bun/darwin-${arch}',
    to: 'runtime/bun/darwin-${arch}'
  }
]

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

function normalizedPath(value) {
  return value.split('\\').join('/').replace(/\/$/, '')
}

export function missingExtraResourceMappings(root = repoRoot) {
  const config = parse(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'))
  return REQUIRED_EXTRA_RESOURCE_MAPPINGS.filter((required) => {
    const value = required.section.split('.').reduce((current, key) => current?.[key], config)
    const entries = Array.isArray(value) ? value : []
    return entries.every((entry) => {
      if (typeof entry !== 'object' || entry === null) return true
      return (
        normalizedPath(String(entry.from ?? '')) !== required.from ||
        normalizedPath(String(entry.to ?? '')) !== required.to
      )
    })
  }).map(({ section, from, to }) => `${section}: ${from} -> ${to}`)
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
  const missingResources = missingExtraResourceMappings()
  if (missing.length > 0 || missingResources.length > 0) {
    if (missing.length > 0) {
      console.error('electron-builder.yml asarUnpack misses files the OMP worker needs at runtime:')
      for (const filePath of missing) console.error(`  - ${filePath}`)
    }
    if (missingResources.length > 0) {
      console.error('electron-builder.yml extraResources misses required mappings:')
      for (const mapping of missingResources) console.error(`  - ${mapping}`)
    }
    process.exit(1)
  }
  console.log('asarUnpack covers the OMP worker closure and packaged helper resources.')
}
