/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * Local regression gate.
 *
 * `bun run test` runs every top-level suite, including the ones that need host
 * capabilities a restricted runner does not grant. This gate runs the same
 * suites minus the ones listed in test-known-failures.json, and it re-checks
 * environment probes at runtime so a capable host still runs them.
 *
 * Usage:
 *   node scripts/test-gate.mjs              run the gate
 *   node scripts/test-gate.mjs --list       print the resolved plan
 *   node scripts/test-gate.mjs --only-skipped   run only the skipped suites
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

/** Host capabilities a suite may need. Absent means "not granted here". */
function probePs() {
  try {
    execFileSync('/bin/ps', ['-o', 'pid=', '-p', String(process.pid)], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return true
  } catch {
    return false
  }
}

const probes = { ps: probePs() }

function loadKnownFailures() {
  const parsed = JSON.parse(readFileSync(knownFailuresPath, 'utf8'))
  const entries = Array.isArray(parsed.entries) ? parsed.entries : []
  const byFile = new Map()
  for (const entry of entries) {
    if (typeof entry?.file !== 'string' || typeof entry?.kind !== 'string') {
      throw new Error('Every known-failure entry needs a string "file" and "kind".')
    }
    if (byFile.has(entry.file)) {
      throw new Error(`Duplicate known-failure entry for ${entry.file}`)
    }
    byFile.set(entry.file, entry)
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
    const missingProbe = entry.kind === 'environment' && entry.probe && !probes[entry.probe]
    if (missingProbe) {
      skipped.push({ file, kind: entry.kind, why: `host lacks "${entry.probe}"` })
      continue
    }
    if (entry.kind === 'fixture') {
      skipped.push({ file, kind: entry.kind, why: 'known red test' })
      continue
    }
    // An environment entry whose probe now passes: the suite must run again.
    run.push(file)
  }

  for (const [file, entry] of entries) {
    if (typeof entry.reviewBy === 'string' && entry.reviewBy < todayIso()) {
      stale.push(file)
    }
    if (entry.scope === 'main' && !files.includes(file)) {
      stale.push(`${file} (no longer exists)`)
    }
  }

  return { run, skipped, stale }
}

function printPlan(plan) {
  console.log(`Gate plan: ${plan.run.length} suite(s) to run, ${plan.skipped.length} skipped.`)
  for (const item of plan.skipped) {
    console.log(`  skip ${item.file} — ${item.why}`)
  }
  for (const item of plan.stale) {
    console.log(`  STALE known-failure entry: ${item}`)
  }
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
