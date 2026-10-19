/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * Local regression gate.
 *
 * `bun run test` runs every top-level suite, including the ones that need host
 * capabilities a restricted runner does not grant. This gate runs the same
 * suites minus the entries in test-known-failures.json, and it re-checks the
 * environment probes on every run so a capable host still executes them.
 *
 * Usage:
 *   node scripts/test-gate.mjs                 run the gate
 *   node scripts/test-gate.mjs --list          print the resolved plan
 *   node scripts/test-gate.mjs --only-skipped  run only the skipped suites
 */
import { execFileSync, spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testsDir = path.join(repoRoot, 'tests')
const knownFailuresPath = path.join(repoRoot, 'scripts/test-known-failures.json')
const loaderPath = path.join(repoRoot, 'scripts/test-loader.mjs')

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const onlySkipped = args.includes('--only-skipped')

/** Host capabilities a suite may need. A missing key means "not granted here". */
const PROBES = {
  /** The launch wrapper proves it is a group leader with `ps -o pgid=`. */
  ps: () => {
    try {
      execFileSync('/bin/ps', ['-o', 'pid=', '-p', String(process.pid)], {
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return true
    } catch {
      return false
    }
  },
  /** The launch wrapper takes the run lock with the flock(1) binary. */
  flock: () => {
    try {
      execFileSync('/bin/sh', ['-c', 'command -v flock'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
}

const probes = Object.fromEntries(Object.entries(PROBES).map(([key, run]) => [key, run()]))

function loadKnownFailures() {
  const parsed = JSON.parse(readFileSync(knownFailuresPath, 'utf8'))
  const profiles = parsed.profiles ?? {}
  const entries = Array.isArray(parsed.entries) ? parsed.entries : []
  const byFile = new Map()

  for (const entry of entries) {
    if (typeof entry?.file !== 'string') {
      throw new Error('Every known-failure entry needs a string "file".')
    }
    if (byFile.has(entry.file)) {
      throw new Error(`Duplicate known-failure entry for ${entry.file}`)
    }
    const profile = typeof entry.profile === 'string' ? profiles[entry.profile] : undefined
    if (entry.profile && !profile) {
      throw new Error(`${entry.file} names unknown profile "${entry.profile}"`)
    }
    const resolved = { ...profile, ...entry }
    if (typeof resolved.kind !== 'string') {
      throw new Error(`${entry.file} needs a "kind" or a profile that provides one.`)
    }
    const required = resolved.probes ?? resolved.probe
    resolved.requiredProbes = required === undefined ? [] : [required].flat()
    byFile.set(entry.file, resolved)
  }
  return byFile
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function topLevelSuites() {
  return readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `tests/${name}`)
    .sort()
}

function resolvePlan(entries) {
  const files = topLevelSuites()
  const run = []
  const skipped = []
  const stale = []

  for (const file of files) {
    const entry = entries.get(file)
    if (!entry) {
      run.push(file)
      continue
    }

    if (entry.kind === 'environment') {
      if (entry.alwaysSkip) {
        skipped.push({ file, why: 'host capability cannot be probed cheaply (see reason)' })
        continue
      }
      const missing = entry.requiredProbes.filter((probe) => !probes[probe])
      if (missing.length > 0) {
        skipped.push({ file, why: `host lacks ${missing.map((probe) => `"${probe}"`).join(', ')}` })
        continue
      }
      // Every probe now passes: the suite must run again instead of staying quarantined.
      run.push(file)
      continue
    }

    skipped.push({ file, why: `known red test (${entry.kind})` })
  }

  for (const [file, entry] of entries) {
    if (typeof entry.reviewBy === 'string' && entry.reviewBy < todayIso()) {
      stale.push(`${file} — reviewBy ${entry.reviewBy} has passed`)
    }
    if ((entry.scope ?? 'main') === 'main' && !files.includes(file)) {
      stale.push(`${file} — file no longer exists`)
    }
  }

  return { run, skipped, stale }
}

function printPlan(plan) {
  console.log(`Gate plan: ${plan.run.length} suite(s) to run, ${plan.skipped.length} skipped.`)
  for (const item of plan.skipped) console.log(`  skip ${item.file} — ${item.why}`)
  for (const item of plan.stale) console.log(`  STALE known-failure entry: ${item}`)
  console.log(`  probes: ${JSON.stringify(probes)}`)
}

const entries = loadKnownFailures()
const plan = resolvePlan(entries)

if (listOnly) {
  printPlan(plan)
  process.exit(0)
}

const selected = onlySkipped ? plan.skipped.map((item) => item.file) : plan.run

if (selected.length === 0) {
  console.log('Nothing to run for this selection.')
  process.exit(1)
}

printPlan(plan)
if (plan.stale.length > 0) {
  console.error(
    '\nKnown-failure entries are stale: fix the cause and delete the entry, or update reviewBy.'
  )
  process.exit(1)
}

const concurrency = process.env.PHI_TEST_CONCURRENCY ?? '4'
const retry = !args.includes('--no-retry')
/** Keep the tail only: enough to find failing files, not the whole suite log. */
const OUTPUT_TAIL_BYTES = 4 * 1024 * 1024

function runTests(files, testConcurrency) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        loaderPath,
        '--test',
        `--test-concurrency=${testConcurrency}`,
        '--test-timeout=300000',
        '--test-force-exit',
        ...files
      ],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let tail = ''
    const absorb = (chunk, sink) => {
      sink.write(chunk)
      tail = `${tail}${chunk.toString()}`.slice(-OUTPUT_TAIL_BYTES)
    }
    child.stdout.on('data', (chunk) => absorb(chunk, process.stdout))
    child.stderr.on('data', (chunk) => absorb(chunk, process.stderr))
    child.once('error', () => resolve({ code: 1, tail }))
    child.once('exit', (code) => resolve({ code: code ?? 1, tail }))
  })
}

/**
 * Some suites are shared bodies under tests/ (for example workspace-host-contract.ts)
 * that several runners import. A failure is reported against the shared file, so map
 * it back to the runners that actually need to re-run.
 */
function runnerMap(files) {
  const byHelper = new Map()
  for (const file of files) {
    let source = ''
    try {
      source = readFileSync(path.join(repoRoot, file), 'utf8')
    } catch {
      continue
    }
    for (const match of source.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]))
      // Node reports `tests/x.ts`; relative imports usually omit the extension.
      // Helpers need not be runners themselves: tests/workspace-host-contract.ts is
      // imported by several *.test.ts files and failures are reported against it.
      const candidates = resolved.endsWith('.ts') ? [resolved] : [resolved, `${resolved}.ts`]
      for (const candidate of candidates) {
        if (!byHelper.has(candidate)) byHelper.set(candidate, new Set())
        byHelper.get(candidate).add(file)
      }
    }
  }
  return byHelper
}

const runnersByHelper = runnerMap(selected)

/** Files named in the failure section; node prints `test at <file>:<line>`. */
function failedFiles(output) {
  const named = new Set()
  for (const match of output.matchAll(
    /test at ((?:file:\/\/)?[^\s:(]*tests\/[^\s:()]+\.ts):\d+/g
  )) {
    named.add(match[1].replace(/^file:\/\//, '').replace(/^.*?(?=tests\/)/, ''))
  }
  for (const match of output.matchAll(
    /\(((?:file:\/\/)?[^\s:()]*tests\/[^\s:()]+\.ts):\d+:\d+\)/g
  )) {
    named.add(match[1].replace(/^file:\/\//, '').replace(/^.*?(?=tests\/)/, ''))
  }
  const runners = new Set()
  for (const file of named) {
    if (selected.includes(file)) {
      runners.add(file)
      continue
    }
    for (const runner of runnersByHelper.get(file) ?? []) runners.add(runner)
  }
  return [...runners]
}

const first = await runTests(selected, concurrency)
if (first.code === 0) process.exit(0)

if (!retry) process.exit(first.code)

const retryFiles = failedFiles(first.tail)
if (retryFiles.length === 0) {
  console.error(
    '\nGate failed and no failing suite could be identified; re-run the selection above by hand.'
  )
  process.exit(first.code)
}

console.log(
  `\nGate failed in ${retryFiles.length} suite(s); retrying them serially to tell flakes from real failures:` +
    retryFiles.map((file) => `\n  ${file}`).join('')
)
const second = await runTests(retryFiles, '1')
if (second.code === 0) {
  console.log(
    'Retry passed: the failure is load-sensitive, not a regression. Report it, do not ignore it.'
  )
  process.exit(0)
}
console.error('Retry failed too: this is a real failure.')
process.exit(second.code)
