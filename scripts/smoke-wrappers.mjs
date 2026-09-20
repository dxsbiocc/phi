#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Smoke-tests every bundled wrapper under `resources/wrappers/`, in tiers:
//
//   1. static   (always)   wrapper triad present, params.json validates against
//                          wrapper.yaml, includes resolve, a primary output exists.
//   2. urls     (default)  every http(s) URL in params.json is reachable.
//                          Skip with --offline.
//   3. preview  (--preview) `nextflow run -preview`: the script compiles and the
//                          channel wiring is valid; no process is executed.
//   4. run      (--run)    the fixed real command with the wrapper's own
//                          params.json, then checks every primary output exists.
//
// Usage (needs the TS loader, so go through the npm script):
//   npm run smoke:wrappers                            # static + urls, all wrappers
//   npm run smoke:wrappers -- --offline               # static only
//   npm run smoke:wrappers -- fastqc samtools         # only ids containing these
//   npm run smoke:wrappers -- --preview               # + nextflow -preview
//   npm run smoke:wrappers -- --run --profile docker  # + real runs (slow)
//   npm run smoke:wrappers -- --json report.json      # machine-readable report
//
// Exit code is 1 when any wrapper has an error; warnings do not fail the run.
// `nextflow` is found via NEXTFLOW_BIN, PATH, or a conda env (see executor.ts).

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(repoRoot) // getBundledWrapperPackagesDir() resolves against cwd outside Electron

// Node's fetch ignores HTTP(S)_PROXY by default, which would report every URL as
// unreachable behind a proxy. Opt in when this Node has the API (24.5+).
const hasProxyEnv = Boolean(process.env.HTTPS_PROXY ?? process.env.https_proxy)
if (hasProxyEnv) {
  if (typeof http.setGlobalProxyFromEnv === 'function') http.setGlobalProxyFromEnv()
  else
    console.warn('HTTPS_PROXY is set but this Node cannot use it for fetch; URL checks may fail.')
}

const src = (path) =>
  new URL(`../src/main/agent/wrappers/composition/${path}`, import.meta.url).href
const { listWrapperCompositionCatalog, readWrapperDefaultParams } = await import(
  src('discovery.ts')
)
const { checkWrapperStatic, collectRemoteUrls, probeUrl } = await import(src('smoke.ts'))
const { findNextflowBinary, runWrapperComposition, WRAPPER_EXECUTION_PROFILES } = await import(
  src('executor.ts')
)
const { findMissingPrimaryOutputs } = await import(src('validate.ts'))

// --- arguments -------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    filters: [],
    offline: false,
    preview: false,
    run: false,
    profile: 'docker',
    timeoutMin: 20,
    jobs: 8,
    json: undefined
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) fail(`${arg} needs a value`)
      return next
    }
    if (arg === '--offline') options.offline = true
    else if (arg === '--preview') options.preview = true
    else if (arg === '--run') options.run = true
    else if (arg === '--profile') options.profile = value()
    else if (arg === '--timeout-min') options.timeoutMin = Number(value())
    else if (arg === '--jobs') options.jobs = Number(value())
    else if (arg === '--json') options.json = value()
    else if (arg.startsWith('-')) fail(`Unknown option: ${arg}`)
    else options.filters.push(arg)
  }
  if (!WRAPPER_EXECUTION_PROFILES.includes(options.profile)) {
    fail(`--profile must be one of ${WRAPPER_EXECUTION_PROFILES.join(', ')}`)
  }
  if (!(options.timeoutMin > 0)) fail('--timeout-min must be a positive number')
  if (!(options.jobs >= 1)) fail('--jobs must be at least 1')
  return options
}

function fail(message) {
  console.error(message)
  process.exit(2)
}

// --- helpers ---------------------------------------------------------------

/** Runs `tasks` (async thunks) with at most `limit` in flight; keeps result order. */
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

const error = (check, message) => ({ level: 'error', check, message })

/** Component-dir entries created by a Nextflow run; removed afterwards so the repo stays clean. */
function snapshotDir(dir) {
  return new Set(readdirSync(dir))
}

function cleanNewArtifacts(componentDir, before) {
  for (const name of readdirSync(componentDir)) {
    if (before.has(name)) continue
    if (name === 'work' || name === 'results' || name.startsWith('.nextflow')) {
      rmSync(join(componentDir, name), { recursive: true, force: true })
    }
  }
}

function nextflowEnv(nextflowBin) {
  return { ...process.env, PATH: `${dirname(nextflowBin)}:${process.env.PATH ?? ''}` }
}

function runCapture(bin, args, options) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, options)
    let output = ''
    const collect = (chunk) => {
      output = (output + chunk.toString('utf-8')).slice(-4000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (err) => resolve({ code: -1, output: String(err) }))
    child.on('close', (code) => resolve({ code: code ?? -1, output }))
  })
}

function lastLines(text, count) {
  return text.trim().split('\n').slice(-count).join('\n')
}

// --- tiers -----------------------------------------------------------------

async function checkPreview(entry, nextflowBin) {
  const before = snapshotDir(entry.componentDir)
  const paramsDir = mkdtempSync(join(tmpdir(), 'phi-smoke-preview-'))
  try {
    const paramsFile = join(paramsDir, 'params.json')
    writeFileSync(paramsFile, JSON.stringify(readWrapperDefaultParams(entry.wrapperDir)))
    const result = await runCapture(
      nextflowBin,
      ['run', 'wrapper/main.nf', '-params-file', paramsFile, '-preview'],
      { cwd: entry.componentDir, env: nextflowEnv(nextflowBin) }
    )
    return result.code === 0
      ? []
      : [error('preview', `nextflow -preview failed:\n${lastLines(result.output, 8)}`)]
  } finally {
    rmSync(paramsDir, { recursive: true, force: true })
    cleanNewArtifacts(entry.componentDir, before)
  }
}

async function checkRun(entry, options) {
  const before = snapshotDir(entry.componentDir)
  const outRoot = mkdtempSync(join(tmpdir(), 'phi-smoke-out-'))
  const overrides = {}
  if (entry.manifest.params.outdir?.kind === 'output') overrides.outdir = join(outRoot, 'results')
  try {
    const result = await runWrapperComposition(entry.wrapperDir, overrides, options.profile, {
      signal: AbortSignal.timeout(options.timeoutMin * 60_000)
    })
    if (!result.success) {
      const why = result.cancelled
        ? `timed out after ${options.timeoutMin} min`
        : `exit ${result.exitCode}`
      return [error('run', `nextflow run failed (${why}):\n${lastLines(result.output, 12)}`)]
    }
    const merged = { ...readWrapperDefaultParams(entry.wrapperDir), ...overrides }
    const missing = findMissingPrimaryOutputs(entry.manifest, merged, entry.componentDir)
    return missing.map((output) => error('run', `primary output missing after run: ${output}`))
  } finally {
    rmSync(outRoot, { recursive: true, force: true })
    cleanNewArtifacts(entry.componentDir, before)
  }
}

function dockerIsUp() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

// --- main ------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2))
const label = (entry) => entry.manifest.id

let entries = listWrapperCompositionCatalog().sort((a, b) => label(a).localeCompare(label(b)))
if (options.filters.length > 0) {
  entries = entries.filter((entry) =>
    options.filters.some((filter) => label(entry).includes(filter))
  )
}
if (entries.length === 0) fail('No wrappers matched.')

let nextflowBin
if (options.preview || options.run) {
  try {
    nextflowBin = findNextflowBinary()
  } catch (err) {
    fail(String(err.message ?? err))
  }
  if (options.run && options.profile === 'docker' && !dockerIsUp()) {
    fail('--run --profile docker needs a running Docker daemon (docker info failed).')
  }
}

const tiers = [
  'static',
  ...(options.offline ? [] : ['urls']),
  ...(options.preview ? ['preview'] : []),
  ...(options.run ? ['run'] : [])
]
console.log(`Smoke-testing ${entries.length} wrapper(s) [${tiers.join(' + ')}]`)

const report = new Map(entries.map((entry) => [label(entry), { id: label(entry), issues: [] }]))
const add = (entry, issues) => report.get(label(entry)).issues.push(...issues)

// Tier 1: static.
for (const entry of entries) add(entry, checkWrapperStatic(entry))

// Tier 2: URLs. Probe each distinct URL once, however many wrappers share it.
if (!options.offline) {
  const urlOwners = new Map()
  for (const entry of entries) {
    for (const url of collectRemoteUrls(readWrapperDefaultParams(entry.wrapperDir))) {
      urlOwners.set(url, [...(urlOwners.get(url) ?? []), entry])
    }
  }
  const urls = [...urlOwners.keys()]
  console.log(`Probing ${urls.length} distinct URL(s)...`)
  const probes = await mapLimited(urls, options.jobs, (url) => probeUrl(url))
  urls.forEach((url, index) => {
    const probe = probes[index]
    if (probe.ok) return
    const reason = probe.status ? `HTTP ${probe.status}` : probe.error
    for (const entry of urlOwners.get(url))
      add(entry, [error('url', `unreachable (${reason}): ${url}`)])
  })
}

// Tiers 3 and 4 run one wrapper at a time: they share Docker/CPU and write into the component dir.
for (const [index, entry] of entries.entries()) {
  if (!options.preview && !options.run) break
  const failedEarlier = report.get(label(entry)).issues.some((issue) => issue.level === 'error')
  if (failedEarlier) continue // a wrapper that fails static/URL checks would only fail slowly here
  process.stdout.write(`[${index + 1}/${entries.length}] ${label(entry)} `)
  const started = Date.now()
  if (options.preview) add(entry, await checkPreview(entry, nextflowBin))
  const previewOk = !report.get(label(entry)).issues.some((issue) => issue.level === 'error')
  if (options.run && previewOk) add(entry, await checkRun(entry, options))
  console.log(`(${Math.round((Date.now() - started) / 1000)}s)`)
}

// --- report ----------------------------------------------------------------

const results = [...report.values()].map((item) => ({
  ...item,
  status: item.issues.some((i) => i.level === 'error')
    ? 'fail'
    : item.issues.length > 0
      ? 'warn'
      : 'ok'
}))

console.log('')
for (const result of results) {
  if (result.status === 'ok') continue
  console.log(`${result.status === 'fail' ? 'FAIL' : 'WARN'}  ${result.id}`)
  for (const item of result.issues) {
    const [first, ...rest] = item.message.split('\n')
    console.log(`  [${item.check}] ${first}`)
    for (const line of rest) console.log(`      ${line}`)
  }
}

const count = (status) => results.filter((result) => result.status === status).length
console.log(
  `\n${count('ok')} ok, ${count('warn')} warn, ${count('fail')} fail (of ${results.length})`
)

if (options.json) {
  writeFileSync(options.json, JSON.stringify({ tiers, results }, null, 2))
  console.log(`Report written to ${options.json}`)
}
if (count('fail') > 0) process.exitCode = 1

// Guard against a stray leftover from an interrupted earlier run in this repo.
if (existsSync(join(repoRoot, 'resources', 'wrappers', '.nextflow'))) {
  console.warn('Note: resources/wrappers/.nextflow exists; remove it if it is not intentional.')
}
