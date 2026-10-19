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
  console.error('\nKnown-failure entries are stale: fix the cause and delete the entry, or update reviewBy.')
  process.exit(1)
}

const concurrency = process.env.PHI_TEST_CONCURRENCY ?? '4'
const child = spawn(
  process.execPath,
  [
    '--import',
    loaderPath,
    '--test',
    `--test-concurrency=${concurrency}`,
    '--test-timeout=300000',
    '--test-force-exit',
    ...selected
  ],
  { cwd: repoRoot, stdio: 'inherit' }
)

child.once('exit', (code) => process.exit(code ?? 1))
