/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Pick the test files a change can affect, so a local edit does not pay for the full suite.
//
// A test is affected when the change touches the test itself or anything it reaches through
// static imports, dynamic imports, or quoted repo paths (source-text tests read files by path).
// Anything the import graph cannot see (lockfile, loader, tsconfig, resources) selects all.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ts = require('typescript')

/** Changes under these paths never affect test outcomes. */
const IGNORED = [/^docs\//, /^[^/]+\.md$/, /^\.claude\//, /^LICENSE$/]
/** Code changes the graph can trace. Everything else is treated as global. */
const TRACEABLE = /^(src|tests)\/.*\.(ts|tsx|mts|mjs|js)$/
const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.tsx']

function isFile(candidate) {
  return existsSync(candidate) && statSync(candidate).isFile()
}

function resolveSpecifier(repoRoot, fromFile, specifier) {
  let base
  if (specifier.startsWith('@renderer/')) {
    base = path.join(repoRoot, 'src/renderer/src', specifier.slice('@renderer/'.length))
  } else if (specifier.startsWith('.')) {
    base = path.resolve(path.dirname(path.join(repoRoot, fromFile)), specifier)
  } else if (/^(src|tests)\//.test(specifier)) {
    base = path.join(repoRoot, specifier)
  } else {
    return null
  }
  base = base.replace(/\?.*$/, '')
  for (const extension of EXTENSIONS) {
    if (isFile(base + extension)) return path.relative(repoRoot, base + extension)
    const withoutJs = base.replace(/\.js$/, '') + extension
    if (extension && isFile(withoutJs)) return path.relative(repoRoot, withoutJs)
  }
  return null
}

function directDependencies(repoRoot, file) {
  const text = readFileSync(path.join(repoRoot, file), 'utf8')
  const specifiers = ts.preProcessFile(text, true, true).importedFiles.map((item) => item.fileName)
  // Quoted repo paths: fixtures spawned by path and tests that read source text.
  for (const match of text.matchAll(
    /['"`]((?:\.{1,2}\/)+[^'"`\s]+|(?:src|tests)\/[^'"`\s]+)['"`]/g
  )) {
    specifiers.push(match[1])
  }
  const resolved = new Set()
  for (const specifier of specifiers) {
    const target = resolveSpecifier(repoRoot, file, specifier)
    if (target) resolved.add(target)
  }
  return resolved
}

/** Map each test file to the set of repo files it can reach. */
function reachableByTest(repoRoot, testFiles) {
  const direct = new Map()
  const depsOf = (file) => {
    if (!direct.has(file)) direct.set(file, directDependencies(repoRoot, file))
    return direct.get(file)
  }
  const reach = new Map()
  for (const test of testFiles) {
    const seen = new Set()
    const stack = [test]
    while (stack.length > 0) {
      const file = stack.pop()
      if (seen.has(file)) continue
      seen.add(file)
      for (const dependency of depsOf(file)) stack.push(dependency)
    }
    reach.set(test, seen)
  }
  return reach
}

/** Files changed against `base` plus uncommitted and untracked files. */
export function changedFiles(repoRoot, base) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean)
  const files = new Set([
    ...git('diff', '--name-only', `${base}...HEAD`),
    ...git('diff', '--name-only', 'HEAD'),
    ...git('ls-files', '--others', '--exclude-standard')
  ])
  return [...files]
}

/**
 * @returns {{ all: boolean, reason?: string, files: string[] }} `all` means the change is
 * outside what the graph can trace and the caller should run its whole selection.
 */
export function selectAffected(repoRoot, changed, testFiles) {
  const relevant = changed.filter((file) => !IGNORED.some((pattern) => pattern.test(file)))
  const untraceable = relevant.find((file) => !TRACEABLE.test(file))
  if (untraceable) return { all: true, reason: untraceable, files: testFiles }
  if (relevant.length === 0) return { all: false, files: [] }
  const changedSet = new Set(relevant)
  const reach = reachableByTest(repoRoot, testFiles)
  const files = testFiles.filter((test) =>
    [...reach.get(test)].some((file) => changedSet.has(file))
  )
  return { all: false, files }
}
