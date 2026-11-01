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
 *   node scripts/test-gate.mjs --changed       run only suites the current change can affect
 *   node scripts/test-gate.mjs --changed=<ref> same, diffing against <ref> (default: main)
 *   node scripts/test-gate.mjs --shard=1/4     run one of four equal parts of the selection
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  changedFiles,
  failureLocations,
  hasTestSummary,
  selectAffected,
  selectShard,
  splitSerialSuites,
  suitesForFailures
} from './test-affected.mjs'
import { runWithReportFile } from './test-run-report.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testsDir = path.join(repoRoot, 'tests')
const knownFailuresPath = path.join(repoRoot, 'scripts/test-known-failures.json')
const loaderPath = path.join(repoRoot, 'scripts/test-loader.mjs')
const blockingStdioPath = path.join(repoRoot, 'scripts/test-blocking-stdio.mjs')

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const onlySkipped = args.includes('--only-skipped')
const changedArg = args.find((arg) => arg === '--changed' || arg.startsWith('--changed='))
const changedBase = changedArg?.includes('=') ? changedArg.slice('--changed='.length) : 'main'
const shardArg = args.find((arg) => arg.startsWith('--shard='))?.slice('--shard='.length)

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

function selectSuites() {
  const base = onlySkipped ? plan.skipped.map((item) => item.file) : plan.run
  if (!changedArg) return base
  const changed = changedFiles(repoRoot, changedBase)
  const affected = selectAffected(repoRoot, changed, base)
  if (affected.all) {
    console.log(
      `--changed: ${affected.reason} is outside the import graph; running the full selection.`
    )
  } else {
    console.log(
      `--changed: ${changed.length} changed file(s) against ${changedBase}; ` +
        `${affected.files.length} of ${base.length} suite(s) affected.`
    )
  }
  return affected.files
}

const selection = selectSuites()
const selected = shardArg === undefined ? selection : selectShard(selection, shardArg)
if (shardArg !== undefined) {
  console.log(`--shard=${shardArg}: ${selected.length} of ${selection.length} suite(s).`)
}

if (selected.length === 0) {
  console.log('Nothing to run for this selection.')
  process.exit(changedArg || shardArg !== undefined ? 0 : 1)
}

printPlan(plan)
if (plan.stale.length > 0) {
  console.error(
    '\nKnown-failure entries are stale: fix the cause and delete the entry, or update reviewBy.'
  )
  process.exit(1)
}

// Most slow suites wait on fake SSH/Slurm hosts rather than burn CPU, so half the cores is a
// safe default; the serial retry below still separates load-sensitive flakes from failures.
const concurrency =
  process.env.PHI_TEST_CONCURRENCY ?? String(Math.max(4, Math.floor(availableParallelism() / 2)))
const retry = !args.includes('--no-retry')

function runTests(files, testConcurrency) {
  return runWithReportFile(
    [
      '--import',
      loaderPath,
      '--import',
      blockingStdioPath,
      '--test',
      `--test-concurrency=${testConcurrency}`,
      '--test-timeout=300000',
      '--test-force-exit',
      ...files
    ],
    { cwd: repoRoot, onOutput: (chunk) => process.stdout.write(chunk) }
  )
}

/** Re-runs what one failed lane left unproven and returns the exit code that decides the gate. */
async function recover(failedLane) {
  let failed = failedLane
  // A finished run always prints its totals. Without them the runner itself died, and every suite
  // it had not reported is unproven, so the whole lane runs once more.
  if (!hasTestSummary(failed.tail)) {
    console.error(
      `\nThe test runner died without a summary (code ${failed.code}, signal ${failed.signal ?? 'none'}); ` +
        'running the lane once more. Report it, do not ignore it.'
    )
    const rerun = await runTests(failed.files, failed.concurrency)
    if (!hasTestSummary(rerun.tail)) return rerun.code || 1
    if (rerun.code === 0) return 0
    failed = { ...failed, ...rerun }
  }

  const { suites: retryFiles, unowned } = suitesForFailures(
    repoRoot,
    failureLocations(failed.tail),
    selected
  )
  if (unowned.length > 0) {
    console.error(
      `\nNo selected suite re-runs these failures, so they cannot be retried:\n  ${unowned.join('\n  ')}`
    )
    return failed.code
  }
  if (retryFiles.length === 0) {
    console.error(
      '\nGate failed and no failing suite could be identified; re-run the selection above by hand.'
    )
    return failed.code
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
    return 0
  }
  console.error('Retry failed too: this is a real failure.')
  return second.code
}

const { parallel, serial } = splitSerialSuites(selected)
const lanes = [
  { files: parallel, concurrency },
  { files: serial, concurrency: '1' }
].filter((lane) => lane.files.length > 0)
const failedLanes = []
for (const lane of lanes) {
  const run = await runTests(lane.files, lane.concurrency)
  if (run.code !== 0 || !hasTestSummary(run.tail)) failedLanes.push({ ...lane, ...run })
}
if (failedLanes.length > 0 && !retry) {
  process.exitCode = failedLanes[0].code || 1
} else {
  // Not process.exit(): that would cut this gate's own report short in the same way.
  for (const failed of failedLanes) {
    const code = await recover(failed)
    if (!process.exitCode) process.exitCode = code
  }
}
