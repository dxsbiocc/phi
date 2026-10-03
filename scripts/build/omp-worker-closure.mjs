/* eslint-disable @typescript-eslint/explicit-function-return-type */
// The OMP worker (`src/main/agent/omp/omp-sdk-worker.ts`) is not bundled by
// rollup: omp-bridge.ts spawns `bun <worker>.ts` and bun resolves its imports
// from disk at runtime. bun cannot read inside `app.asar`, so in a packaged
// app the worker, every source file it reaches through relative imports, the
// root package.json (read by `readAppVersion()`), and every package it reaches
// through bare imports must sit in `app.asar.unpacked/`.
//
// This module derives that closure from the import graph so the copy plugin
// (electron.vite.config.ts) and the asarUnpack check (check-asar-unpack.mjs)
// cannot drift from what the worker actually imports.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const OMP_WORKER_ENTRY = 'src/main/agent/omp/omp-sdk-worker.ts'

// Static `import ... from`, `export ... from`, side-effect `import '...'`, and
// literal dynamic `import('...')`. Type-only imports are included on purpose:
// copying an extra type file is harmless, missing a value import is not.
const IMPORT_PATTERN =
  /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.mjs']

function toPosix(filePath) {
  return filePath.split(path.sep).join('/')
}

function resolveRelativeImport(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.slice(1).map((ext) => path.join(base, `index${ext}`))
  ]
  const match = candidates.find((candidate) => {
    try {
      readFileSync(candidate)
      return true
    } catch {
      return false
    }
  })
  if (!match) throw new Error(`OMP worker closure: cannot resolve "${specifier}" from ${fromFile}`)
  return match
}

export function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function isBuiltin(specifier) {
  return specifier.startsWith('node:') || specifier.startsWith('bun:')
}

/**
 * Walks relative imports from the worker entry.
 * Returns repo-relative source files and the bare package names they import.
 */
export function collectOmpWorkerSources(repoRoot) {
  const files = new Set()
  const packages = new Set()
  const pending = [path.resolve(repoRoot, OMP_WORKER_ENTRY)]
  while (pending.length > 0) {
    const file = pending.pop()
    if (files.has(file)) continue
    files.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? match[3]
      if (specifier.startsWith('.')) pending.push(resolveRelativeImport(file, specifier))
      else if (!isBuiltin(specifier)) packages.add(packageNameOf(specifier))
    }
  }
  return {
    files: [...files].map((file) => toPosix(path.relative(repoRoot, file))).sort(),
    packages: [...packages].sort()
  }
}

/** `src/main/agent/x.ts` -> `out/main/agent/x.ts`, keeping relative depth intact. */
export function ompWorkerOutputPath(sourcePath) {
  if (!sourcePath.startsWith('src/')) {
    throw new Error(`OMP worker closure: ${sourcePath} is outside src/`)
  }
  return `out/${sourcePath.slice('src/'.length)}`
}

/** Files the copy plugin writes under out/, repo-relative. */
export function ompWorkerOutputFiles(repoRoot) {
  return collectOmpWorkerSources(repoRoot).files.map(ompWorkerOutputPath)
}

export function copyOmpWorkerClosure(repoRoot) {
  for (const sourcePath of collectOmpWorkerSources(repoRoot).files) {
    const target = path.resolve(repoRoot, ompWorkerOutputPath(sourcePath))
    mkdirSync(path.dirname(target), { recursive: true })
    cpSync(path.resolve(repoRoot, sourcePath), target)
  }
}

function findPackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Installed package directories (repo-relative, e.g. `node_modules/yaml`) that
 * the worker's bare imports pull in at runtime: dependencies plus installed
 * optional/peer dependencies, transitively. Only top-level directories are
 * returned; nested `node_modules` ride along with their parent.
 */
export function collectOmpWorkerPackageDirs(repoRoot) {
  const seen = new Set()
  const missing = []
  const visit = (name, fromDir, required) => {
    const dir = findPackageDir(name, fromDir)
    if (!dir) {
      if (required)
        missing.push(`${name} (from ${toPosix(path.relative(repoRoot, fromDir)) || '.'})`)
      return
    }
    if (seen.has(dir)) return
    seen.add(dir)
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    for (const dep of Object.keys(manifest.dependencies ?? {})) visit(dep, dir, true)
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) visit(dep, dir, false)
    for (const dep of Object.keys(manifest.peerDependencies ?? {})) visit(dep, dir, false)
  }
  for (const name of collectOmpWorkerSources(repoRoot).packages) visit(name, repoRoot, true)
  if (missing.length > 0) {
    throw new Error(`OMP worker closure: packages not installed: ${missing.join(', ')}`)
  }
  const topLevelPrefix = `node_modules${path.sep}`
  return [...seen]
    .map((dir) => path.relative(repoRoot, dir))
    .filter(
      (dir) =>
        dir.startsWith(topLevelPrefix) &&
        !dir.slice(topLevelPrefix.length).includes(`${path.sep}node_modules${path.sep}`)
    )
    .map(toPosix)
    .sort()
}

// `import x from './file.ext' with { type: 'text' | 'file' | 'json' }` — bun
// loads these targets at runtime, but electron-builder's node_modules copier
// drops some of them unconditionally (`*.d.ts`, `CHANGELOG.md`, top-level
// README/test dirs). The afterPack hook restores them from this list.
const ASSET_IMPORT_PATTERN =
  /(?:import|export)\s[^'"`;]*?\sfrom\s*['"](\.{1,2}\/[^'"]+)['"]\s*with\s*\{[^}]*\btype\s*:\s*['"](?:text|file|json)['"]/g

const PACKAGE_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs'])

function listPackageSources(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && PACKAGE_SOURCE_EXTENSIONS.has(path.extname(entry.name)))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.endsWith('.d.ts'))
}

/**
 * Repo-relative `node_modules/...` files that the worker's runtime packages
 * import through import attributes. Nested `node_modules` are scanned with
 * their parent package.
 */
export function collectOmpWorkerPackageAssets(repoRoot) {
  const assets = new Set()
  for (const packageDir of collectOmpWorkerPackageDirs(repoRoot)) {
    for (const file of listPackageSources(path.resolve(repoRoot, packageDir))) {
      const source = readFileSync(file, 'utf8')
      if (!source.includes(' with ')) continue
      for (const match of source.matchAll(ASSET_IMPORT_PATTERN)) {
        const target = path.resolve(path.dirname(file), match[1])
        if (existsSync(target)) assets.add(toPosix(path.relative(repoRoot, target)))
      }
    }
  }
  return [...assets].sort()
}
