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
 * One part of a partition, `spec` being `<index>/<count>` from 1. Suites of a family sit next to
 * each other once sorted, so taking every count-th one spreads the slow families across shards.
 */
export function selectShard(files, spec) {
  const match = /^(\d+)\/(\d+)$/.exec(spec)
  const index = match ? Number(match[1]) : 0
  const count = match ? Number(match[2]) : 0
  if (index < 1 || index > count) {
    throw new Error(`--shard needs <index>/<count> with 1 <= index <= count, got "${spec}"`)
  }
  return files.filter((_, position) => position % count === index - 1)
}

/**
 * Suites that start real runtimes or bundle and drive Electron. Beside other suites on a small
 * runner they take minutes and push their neighbours past their limits, so they run alone.
 */
export const SERIAL_SUITES = [
  'tests/engine-kernel-acceptance.test.ts',
  'tests/engine-kernel-routing-contract.test.ts',
  'tests/engine-rpc-contract.test.ts',
  'tests/notebook-markdown-editor-interactions.test.ts'
]

export function splitSerialSuites(files) {
  return {
    parallel: files.filter((file) => !SERIAL_SUITES.includes(file)),
    serial: files.filter((file) => SERIAL_SUITES.includes(file))
  }
}

/** A finished run always prints its totals, so without them its result is unproven. */
export function hasTestSummary(output) {
  return /^ℹ tests \d+/m.test(output)
}

/** The file of every failure in a test report: node prints `test at <file>:<line>:<column>`. */
export function failureLocations(output) {
  const files = new Set()
  for (const match of output.matchAll(/^\s*test at (\S+?):\d+:\d+\s*$/gm)) {
    files.add(match[1].replace(/^file:\/\//, '').replace(/^.*?(?=tests\/)/, ''))
  }
  return [...files]
}

/**
 * The selected suites that run each failed file. A failure can be reported against a shared body
 * or helper, so anything that is not a suite itself maps through the import graph. `unowned` lists
 * what no selected suite reaches: nothing can re-run those, so the caller must not pass them.
 */
export function suitesForFailures(repoRoot, failed, selected) {
  const direct = failed.filter((file) => selected.includes(file))
  const indirect = failed.filter((file) => !selected.includes(file))
  const reach = indirect.length > 0 ? reachableByTest(repoRoot, selected) : new Map()
  const runnersOf = (file) => selected.filter((suite) => reach.get(suite).has(file))
  return {
    suites: selected.filter(
      (suite) => direct.includes(suite) || indirect.some((file) => reach.get(suite).has(file))
    ),
    unowned: indirect.filter((file) => runnersOf(file).length === 0)
  }
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
